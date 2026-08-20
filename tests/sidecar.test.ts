import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { makeLibrary } from "./fixtures/gen-library.js";
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
});
