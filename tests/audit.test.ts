// tests/audit.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { makeLibrary } from "./fixtures/gen-library.js";
import { readLibraryInfo } from "../src/discovery.js";
import { QueryProcess } from "../src/proc/query-client.js";
import { IndexManager } from "../src/store/index-manager.js";
import { auditLibrary, AUDIT_CHECKS } from "../src/tools/audit.js";
import { isEngineError } from "../src/errors.js";

let dir: string, mdb: string, qp: QueryProcess;

/**
 * Recomputes a check's expected id set directly from the library file,
 * bypassing auditLibrary entirely. Comparing against this — rather than
 * only asserting shape — is what actually catches a wrong column or a
 * swapped check body: a check that reads the wrong column still returns
 * *some* count, but it won't match the value independently derived from the
 * documented semantics of that specific check name.
 */
function expectedIds(mdbPath: string, sql: string): number[] {
  const db = new DatabaseSync(`file:${mdbPath}?mode=ro`, { readOnly: true });
  try {
    return (db.prepare(sql).all() as { id: number }[]).map((r) => Number(r.id));
  } finally {
    db.close();
  }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "edj-audit-"));
  mdb = makeLibrary(dir, { tracks: 600 });

  // Deterministic, minimal mutations layered onto the random fixture so
  // every check below has a known, small, non-vacuous result. Left to the
  // generator alone: isAvailable, duplicate artist+title pairs, empty
  // metadata, orphaned playlist entries and out-of-range bpm never occur at
  // all, and quickCues/beatData are driven from the same random draw (see
  // task-13-brief.md), which would make a no_cues/no_beatgrid name swap
  // numerically invisible — decorrelating ids 2 and 3 below closes that gap.
  {
    const raw = new DatabaseSync(mdb);
    raw.exec("PRAGMA busy_timeout=3000");
    const blob = Buffer.alloc(64, 7);

    raw.prepare("UPDATE Track SET isAvailable = 0 WHERE id = 1").run();

    // Fill every naturally-missing performance row first, then carve out
    // exactly one no_cues-only and one no_beatgrid-only track.
    raw
      .prepare(
        "UPDATE PerformanceData SET quickCues = ?, beatData = ? WHERE quickCues IS NULL OR beatData IS NULL",
      )
      .run(blob, blob);
    raw.prepare("UPDATE PerformanceData SET quickCues = NULL WHERE trackId = 3").run();
    raw.prepare("UPDATE PerformanceData SET beatData = NULL WHERE trackId = 2").run();

    raw.prepare("UPDATE Track SET bpmAnalyzed = 300 WHERE id = 5").run();
    raw.prepare("UPDATE Track SET title = '' WHERE id = 6").run();
    raw.prepare("UPDATE Track SET artist = ?, title = ? WHERE id IN (7, 8)").run(
      "Duplicate Artist",
      "Duplicate Title",
    );
    raw
      .prepare(`INSERT INTO PlaylistEntity (id, listId, trackId, databaseUuid) VALUES (12345, 1, 999999, 'x')`)
      .run();

    raw.close();
  }

  const lib = readLibraryInfo(mdb);
  if (isEngineError(lib)) throw new Error("fixture library unreadable");
  qp = new QueryProcess(mdb, null, 10_000);
  await new IndexManager(lib, qp, join(dir, "sidecars")).ensureFresh();
});
afterAll(() => {
  qp.dispose();
  rmSync(dir, { recursive: true, force: true });
});

describe("audit_library", () => {
  it("returns counts and a bounded sample, never whole result sets", async () => {
    const r = await auditLibrary(qp, mdb, {});
    expect(isEngineError(r)).toBe(false);
    if (isEngineError(r)) return;
    expect(r.checks.map((c) => c.name).sort()).toEqual([...AUDIT_CHECKS].sort());
    for (const c of r.checks) {
      expect(c.sample_ids.length).toBeLessThanOrEqual(10);
      expect(c.count).toBeGreaterThanOrEqual(c.sample_ids.length);
    }
  }, 30_000);

  it("finds the fixture's missing files, since none exist on disk", async () => {
    const r = await auditLibrary(qp, mdb, { checks: ["missing_files"] });
    expect(isEngineError(r)).toBe(false);
    if (isEngineError(r)) return;
    expect(r.checks[0]!.name).toBe("missing_files");
    expect(r.checks[0]!.count).toBe(600);
  }, 30_000);

  it("finds tracks with an undetermined key", async () => {
    const r = await auditLibrary(qp, mdb, { checks: ["missing_key"] });
    expect(isEngineError(r)).toBe(false);
    if (isEngineError(r)) return;
    expect(r.checks[0]!.count).toBeGreaterThan(0);
  });

  it("rejects an unknown check name instead of ignoring it", async () => {
    const r = await auditLibrary(qp, mdb, { checks: ["not_a_check"] });
    expect(isEngineError(r)).toBe(true);
    if (!isEngineError(r)) return;
    expect(r.error).toBe("invalid_argument");
    expect(r.message).toContain("not_a_check");
  });

  it("rejects malformed input structurally instead of throwing", async () => {
    // checks must be an array of strings; a bare string must not reach
    // Array.prototype.filter inside the implementation as a raw exception.
    const r = await auditLibrary(qp, mdb, { checks: "unavailable" } as any);
    expect(isEngineError(r)).toBe(true);
    if (!isEngineError(r)) return;
    expect(r.error).toBe("invalid_argument");
  });
});

describe("audit_library — each check against an independently computed truth", () => {
  it("unavailable: exactly the one track explicitly marked unavailable", async () => {
    const r = await auditLibrary(qp, mdb, { checks: ["unavailable"] });
    expect(isEngineError(r)).toBe(false);
    if (isEngineError(r)) return;
    const expected = expectedIds(mdb, "SELECT id FROM Track WHERE isAvailable = 0");
    expect(expected).toEqual([1]);
    expect(r.checks[0]!.count).toBe(1);
    expect(r.checks[0]!.sample_ids).toEqual([1]);
  });

  it("unanalyzed: count matches the independently computed set from isAnalyzed", async () => {
    const r = await auditLibrary(qp, mdb, { checks: ["unanalyzed"] });
    expect(isEngineError(r)).toBe(false);
    if (isEngineError(r)) return;
    const expected = expectedIds(mdb, "SELECT id FROM Track WHERE isAnalyzed = 0 OR isAnalyzed IS NULL");
    // Non-vacuous: the fixture's ~10% analysis failure rate over 600 tracks
    // makes an empty result here implausible enough to also assert directly.
    expect(expected.length).toBeGreaterThan(0);
    expect(r.checks[0]!.count).toBe(expected.length);
  });

  it("no_cues and no_beatgrid: decorrelated ids prove the two checks are not swapped", async () => {
    const r = await auditLibrary(qp, mdb, { checks: ["no_cues", "no_beatgrid"] });
    expect(isEngineError(r)).toBe(false);
    if (isEngineError(r)) return;
    const cues = r.checks.find((c) => c.name === "no_cues")!;
    const grid = r.checks.find((c) => c.name === "no_beatgrid")!;
    // id 3 has no cues but does have a beatgrid; id 2 is the reverse. If the
    // two checks were swapped, or both read the same column, these would
    // come out identical instead.
    expect(cues.count).toBe(1);
    expect(cues.sample_ids).toEqual([3]);
    expect(grid.count).toBe(1);
    expect(grid.sample_ids).toEqual([2]);
  });

  it("missing_key: count matches the independently computed set from key", async () => {
    const r = await auditLibrary(qp, mdb, { checks: ["missing_key"] });
    expect(isEngineError(r)).toBe(false);
    if (isEngineError(r)) return;
    const expected = expectedIds(mdb, "SELECT id FROM Track WHERE key = -1 OR key IS NULL");
    expect(expected.length).toBeGreaterThan(0);
    expect(r.checks[0]!.count).toBe(expected.length);
  });

  it("suspicious_bpm: exactly the one track with a bpmAnalyzed/bpm mismatch", async () => {
    const r = await auditLibrary(qp, mdb, { checks: ["suspicious_bpm"] });
    expect(isEngineError(r)).toBe(false);
    if (isEngineError(r)) return;
    // The generator keeps bpmAnalyzed within 0.4 of bpm/100 and both inside
    // [118, 140] for every other track, so id 5 (bpmAnalyzed forced to 300)
    // is the only one that can trip either branch of the check.
    expect(r.checks[0]!.count).toBe(1);
    expect(r.checks[0]!.sample_ids).toEqual([5]);
  });

  it("empty_metadata: exactly the one track with a blanked title", async () => {
    const r = await auditLibrary(qp, mdb, { checks: ["empty_metadata"] });
    expect(isEngineError(r)).toBe(false);
    if (isEngineError(r)) return;
    expect(r.checks[0]!.count).toBe(1);
    expect(r.checks[0]!.sample_ids).toEqual([6]);
  });

  it("duplicates: exactly the two tracks sharing artist and title", async () => {
    const r = await auditLibrary(qp, mdb, { checks: ["duplicates"] });
    expect(isEngineError(r)).toBe(false);
    if (isEngineError(r)) return;
    expect(r.checks[0]!.count).toBe(2);
    expect([...r.checks[0]!.sample_ids].sort()).toEqual([7, 8]);
  });

  it("orphan_entries: exactly the one playlist entry pointing at a nonexistent track", async () => {
    const r = await auditLibrary(qp, mdb, { checks: ["orphan_entries"] });
    expect(isEngineError(r)).toBe(false);
    if (isEngineError(r)) return;
    expect(r.checks[0]!.count).toBe(1);
    expect(r.checks[0]!.sample_ids).toEqual([12345]);
  });
});

describe("audit_library — missing_files path resolution", () => {
  // Isolated from the shared fixture above so materialising a real file on
  // disk here cannot change the other describe blocks' expected counts.
  let localDir: string, localMdb: string, localQp: QueryProcess;

  beforeAll(async () => {
    localDir = mkdtempSync(join(tmpdir(), "edj-audit-paths-"));
    localMdb = makeLibrary(localDir, { tracks: 5 });
    const lib = readLibraryInfo(localMdb);
    if (isEngineError(lib)) throw new Error("fixture library unreadable");
    localQp = new QueryProcess(localMdb, null, 10_000);
    await new IndexManager(lib, localQp, join(localDir, "sidecars")).ensureFresh();
  });
  afterAll(() => {
    localQp.dispose();
    rmSync(localDir, { recursive: true, force: true });
  });

  it("resolves Track.path against the grandparent of m.db, not the Database2 folder", async () => {
    // Confirms the sample really is bounded, not just usually small.
    const before = await auditLibrary(localQp, localMdb, { checks: ["missing_files"] });
    expect(isEngineError(before)).toBe(false);
    if (isEngineError(before)) return;
    expect(before.checks[0]!.count).toBe(5);

    // Independently — without importing absTrackPath — place a real file
    // exactly where "relative to the Engine Library folder" says it must
    // go: m.db lives at .../Engine Library/Database2/m.db, so the Engine
    // Library folder is m.db's grandparent directory. Track 3's stored path
    // is "../Music/lib/3/t3.mp3". An implementation that resolved one level
    // too shallow (against Database2) or too deep (against localDir) would
    // look somewhere else entirely and never find this file.
    const row = new DatabaseSync(`file:${localMdb}?mode=ro`, { readOnly: true });
    const relative = String((row.prepare("SELECT path FROM Track WHERE id = 3").get() as any).path);
    row.close();
    expect(relative).toBe("../Music/lib/3/t3.mp3");

    const engineLibraryDir = dirname(dirname(localMdb));
    const target = resolve(engineLibraryDir, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "not a real mp3, just needs to exist");
    expect(existsSync(target)).toBe(true);

    const after = await auditLibrary(localQp, localMdb, { checks: ["missing_files"] });
    expect(isEngineError(after)).toBe(false);
    if (isEngineError(after)) return;
    expect(after.checks[0]!.count).toBe(4);
    expect(after.checks[0]!.sample_ids).not.toContain(3);
  });
});
