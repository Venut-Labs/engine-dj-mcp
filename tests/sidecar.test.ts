import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { makeLibrary } from "./fixtures/gen-library.js";
import { cueFrame, emptyCue } from "./fixtures/blob-frames.js";
import { buildSidecar } from "../src/sidecar/build.js";

let dir: string, mdb: string, side: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "edj-side-"));
  mdb = makeLibrary(dir, { tracks: 2000 });
  side = join(dir, "index.db");
  buildSidecar({ mdbPath: mdb, outPath: side, uuid: "u", schema: "3.0.2" });
});
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

describe("sidecar", () => {
  it("indexes every track", () => {
    const db = new DatabaseSync(side, { readOnly: true });
    expect((db.prepare("SELECT COUNT(*) c FROM track_derived").get() as any).c).toBe(2000);
    expect((db.prepare("SELECT COUNT(*) c FROM fts_map").get() as any).c).toBe(2000);
    db.close();
  });

  it("matches full text with diacritics folded", () => {
    const db = new DatabaseSync(side, { readOnly: true });
    // Engine itself only does LIKE and misses "Ämbient" for "ambient".
    const hit = db.prepare("SELECT COUNT(*) c FROM fts_track WHERE fts_track MATCH 'ambient'").get() as any;
    expect(hit.c).toBeGreaterThan(0);
    db.close();
  });

  it("uses an index for the camelot filter rather than scanning", () => {
    const db = new DatabaseSync(side, { readOnly: true });
    const plan = (db.prepare("EXPLAIN QUERY PLAN SELECT track_id FROM track_derived WHERE camelot = '8A'").all() as any[])
      .map((r) => r.detail).join(" ");
    expect(plan).toMatch(/USING (COVERING )?INDEX/);
    db.close();
  });

  it("records the change counter it was built against", () => {
    const db = new DatabaseSync(side, { readOnly: true });
    const meta = db.prepare("SELECT * FROM index_meta").get() as any;
    expect(meta.library_uuid).toBe("u");
    expect(meta.schema_version).toBe("3.0.2");
    expect(typeof meta.change_counter).toBe("number");
    db.close();
  });

  it("cleans up the sidecar file if build fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "edj-side-fail-"));
    try {
      const mdb = makeLibrary(dir, { tracks: 10 });
      const side = join(dir, "index.db");

      // Break the library by dropping PerformanceData so the JOIN fails
      const engineDb = new DatabaseSync(mdb);
      engineDb.exec("DROP TABLE IF EXISTS PerformanceData");
      engineDb.close();

      // Build should throw
      expect(() => buildSidecar({ mdbPath: mdb, outPath: side, uuid: "u", schema: "3.0.2" })).toThrow();

      // File must not exist
      expect(existsSync(side)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records has_cues and has_grid correctly without swapping", () => {
    const dir = mkdtempSync(join(tmpdir(), "edj-side-cues-"));
    try {
      const mdb = makeLibrary(dir, { tracks: 2 });
      const side = join(dir, "index.db");

      // Customize the library: one track with cues only, one with grid only
      const engineDb = new DatabaseSync(mdb);
      const trackIds = (engineDb.prepare("SELECT id FROM Track LIMIT 2").all() as any[]).map((r) => r.id);

      // Clear existing PerformanceData
      engineDb.exec("DELETE FROM PerformanceData");

      // First track: a quickCues blob with a cue actually set, and no
      // beatData (has_cues = 1, has_grid = 0). It has to be a real frame
      // now: has_cues is decoded, so three arbitrary bytes would answer 0
      // and this test would pass for the wrong reason under a swap.
      engineDb.prepare(
        "INSERT INTO PerformanceData (trackId, quickCues) VALUES (?, ?)"
      ).run(trackIds[0], cueFrame([{ label: "", position: 44_100, colour: 0 }, emptyCue]));

      // Second track: beatData only (has_cues = 0, has_grid = 1). has_grid
      // is still a presence test, so any non-empty blob is the right input.
      engineDb.prepare(
        "INSERT INTO PerformanceData (trackId, beatData) VALUES (?, ?)"
      ).run(trackIds[1], Buffer.from([4, 5, 6]));

      engineDb.close();

      buildSidecar({ mdbPath: mdb, outPath: side, uuid: "u", schema: "3.0.2" });

      const sideDb = new DatabaseSync(side, { readOnly: true });
      const rows = (sideDb.prepare("SELECT track_id, has_cues, has_grid FROM track_derived ORDER BY track_id").all() as any[]);

      // First track should have cues but not grid
      expect(rows[0].has_cues).toBe(1);
      expect(rows[0].has_grid).toBe(0);

      // Second track should have grid but not cues
      expect(rows[1].has_cues).toBe(0);
      expect(rows[1].has_grid).toBe(1);

      sideDb.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("has_cues means a cue is set, not that a quickCues blob exists", () => {
    // The whole point of decoding during the rebuild. Engine writes a full
    // eight-slot blob to every analysed track, so a SQL-only rule answers
    // the same thing for both tracks below -- and it answered "has cues"
    // for all 281 blobs of a real library where 3 hold a cue.
    const dir = mkdtempSync(join(tmpdir(), "edj-side-cueset-"));
    try {
      const mdb = makeLibrary(dir, { tracks: 3 });
      const side = join(dir, "index.db");
      const bare = cueFrame(Array.from({ length: 8 }, () => emptyCue));
      const set = cueFrame(
        Array.from({ length: 8 }, (_, i) =>
          i === 7 ? { label: "Cue 8", position: 44_100 * 10, colour: 0 } : emptyCue,
        ),
      );

      const engineDb = new DatabaseSync(mdb);
      engineDb.exec("DELETE FROM PerformanceData");
      const ins = engineDb.prepare("INSERT INTO PerformanceData (trackId, quickCues) VALUES (?, ?)");
      ins.run(1, bare); // analysed, no pad used
      ins.run(2, set); // analysed, hot cue 8 set
      ins.run(3, null); // never analysed

      // Both blobs are present and non-empty, so every SQL-visible property
      // of them agrees: if the two rows below were not identical here, the
      // assertion further down would not be testing what it claims to.
      const lens = engineDb
        .prepare("SELECT trackId, quickCues IS NOT NULL AS present, length(quickCues) > 0 AS nonempty FROM PerformanceData WHERE trackId IN (1,2) ORDER BY trackId")
        .all() as { trackId: number; present: number; nonempty: number }[];
      expect(lens).toEqual([
        { trackId: 1, present: 1, nonempty: 1 },
        { trackId: 2, present: 1, nonempty: 1 },
      ]);
      engineDb.close();

      buildSidecar({ mdbPath: mdb, outPath: side, uuid: "u", schema: "3.0.2" });

      const sideDb = new DatabaseSync(side, { readOnly: true });
      const rows = sideDb
        .prepare("SELECT track_id, has_cues FROM track_derived ORDER BY track_id")
        .all() as { track_id: number; has_cues: number }[];
      sideDb.close();
      expect(rows).toEqual([
        { track_id: 1, has_cues: 0 },
        { track_id: 2, has_cues: 1 },
        { track_id: 3, has_cues: 0 },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rebuilds over an existing sidecar correctly", () => {
    const dir = mkdtempSync(join(tmpdir(), "edj-side-rebuild-"));
    try {
      const mdb = makeLibrary(dir, { tracks: 50 });
      const side = join(dir, "index.db");

      // First build
      const result1 = buildSidecar({ mdbPath: mdb, outPath: side, uuid: "u1", schema: "3.0.1" });
      expect(result1.indexed).toBe(50);

      // Verify first build is present
      let sideDb = new DatabaseSync(side, { readOnly: true });
      let meta = sideDb.prepare("SELECT COUNT(*) c FROM index_meta").get() as any;
      expect(meta.c).toBe(1);
      sideDb.close();

      // Second build over the same path
      const result2 = buildSidecar({ mdbPath: mdb, outPath: side, uuid: "u2", schema: "3.0.2" });
      expect(result2.indexed).toBe(50);

      // Verify only one metadata row exists (old one was replaced)
      sideDb = new DatabaseSync(side, { readOnly: true });
      meta = sideDb.prepare("SELECT COUNT(*) c FROM index_meta").get() as any;
      expect(meta.c).toBe(1);

      // Verify metadata is from second build
      const metaRow = sideDb.prepare("SELECT * FROM index_meta").get() as any;
      expect(metaRow.library_uuid).toBe("u2");
      expect(metaRow.schema_version).toBe("3.0.2");

      // Verify data counts
      const trackCount = sideDb.prepare("SELECT COUNT(*) c FROM track_derived").get() as any;
      expect(trackCount.c).toBe(50);
      sideDb.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
