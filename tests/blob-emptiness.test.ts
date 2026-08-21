// tests/blob-emptiness.test.ts
//
// One question -- "does this track have cues?" -- answered by three modules
// that used three different rules: sidecar/build.ts asked `quickCues IS NOT
// NULL`, tools/audit.ts counted `IS NULL`, and blobs/index.ts reports a
// zero-length blob as `empty`. A track whose quickCues is a present but
// zero-length blob was therefore has_cues: 1 in search, absent from audit's
// no_cues, and `empty` in get_track_performance. These tests pin all three
// to one rule.
//
// That rule has since become stricter than "empty or NULL": has_cues and
// no_cues decode the blob and mean "a hot cue is actually set", because
// Engine writes a full eight-slot blob to every analysed track. A
// zero-length blob is still "no cues" under it -- that is what this file
// checks -- and the third fixture below now carries a blob with a pad
// actually set, since an undecodable one would be "no cues" too and could
// no longer play the "not everything answers 0" role it is here for.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { makeLibrary } from "./fixtures/gen-library.js";
import { cueFrame, emptyCue } from "./fixtures/blob-frames.js";
import { readLibraryInfo } from "../src/discovery.js";
import { QueryProcess } from "../src/proc/query-client.js";
import { IndexManager } from "../src/store/index-manager.js";
import { searchTracks } from "../src/tools/search.js";
import { auditLibrary } from "../src/tools/audit.js";
import { getTrackPerformance } from "../src/tools/performance.js";
import { isEngineError } from "../src/errors.js";

const EMPTY_BLOB_TRACK = 1;
const NULL_BLOB_TRACK = 2;
const REAL_BLOB_TRACK = 3;

let dir: string, mdb: string, qp: QueryProcess;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "edj-emptyblob-"));
  mdb = makeLibrary(dir, { tracks: 6 });

  const raw = new DatabaseSync(mdb);
  raw.prepare("UPDATE PerformanceData SET quickCues = ?, beatData = ? WHERE trackId = ?").run(
    Buffer.alloc(0),
    Buffer.alloc(0),
    EMPTY_BLOB_TRACK,
  );
  raw
    .prepare("UPDATE PerformanceData SET quickCues = NULL, beatData = NULL WHERE trackId = ?")
    .run(NULL_BLOB_TRACK);
  raw
    .prepare("UPDATE PerformanceData SET quickCues = ?, beatData = ? WHERE trackId = ?")
    .run(
      cueFrame(
        Array.from({ length: 8 }, (_, i) =>
          i === 0 ? { label: "", position: 44_100 * 5, colour: 0 } : emptyCue,
        ),
      ),
      Buffer.alloc(32, 7),
      REAL_BLOB_TRACK,
    );

  // The whole finding turns on the distinction between a present-but-empty
  // blob and a NULL one, so prove the fixture really holds that distinction
  // rather than node:sqlite having quietly folded Buffer.alloc(0) to NULL.
  const shape = raw
    .prepare(
      "SELECT trackId, quickCues IS NULL AS is_null, COALESCE(length(quickCues), 0) > 0 AS non_empty FROM PerformanceData WHERE trackId IN (?,?,?) ORDER BY trackId",
    )
    .all(EMPTY_BLOB_TRACK, NULL_BLOB_TRACK, REAL_BLOB_TRACK) as {
    trackId: number;
    is_null: number;
    non_empty: number;
  }[];
  raw.close();
  expect(shape).toEqual([
    { trackId: EMPTY_BLOB_TRACK, is_null: 0, non_empty: 0 },
    { trackId: NULL_BLOB_TRACK, is_null: 1, non_empty: 0 },
    { trackId: REAL_BLOB_TRACK, is_null: 0, non_empty: 1 },
  ]);

  const lib = readLibraryInfo(mdb);
  if (isEngineError(lib)) throw new Error("fixture library unreadable");
  qp = new QueryProcess(mdb, null, 10_000);
  await new IndexManager(lib, qp, join(dir, "sidecars")).ensureFresh();
});
afterAll(() => {
  qp.dispose();
  rmSync(dir, { recursive: true, force: true });
});

describe("a zero-length blob means 'no cues', everywhere", () => {
  it("is has_cues: 0 and has_beatgrid: 0 in search, like a NULL one", async () => {
    const r = await searchTracks(qp, {
      fields: ["id", "has_cues", "has_beatgrid"],
      limit: 10,
    });
    expect(isEngineError(r)).toBe(false);
    if (isEngineError(r)) return;
    const byId = new Map(r.tracks.map((t) => [Number(t.id), t]));
    expect(byId.get(EMPTY_BLOB_TRACK)).toMatchObject({ has_cues: 0, has_beatgrid: 0 });
    expect(byId.get(NULL_BLOB_TRACK)).toMatchObject({ has_cues: 0, has_beatgrid: 0 });
    // Non-vacuous: a rule that answered 0 for everything would pass the two
    // assertions above.
    expect(byId.get(REAL_BLOB_TRACK)).toMatchObject({ has_cues: 1, has_beatgrid: 1 });
  });

  it("is counted by audit_library's no_cues and no_beatgrid, like a NULL one", async () => {
    const r = await auditLibrary(qp, mdb, { checks: ["no_cues", "no_beatgrid"] });
    expect(isEngineError(r)).toBe(false);
    if (isEngineError(r)) return;
    for (const check of r.checks) {
      expect(check.sample_ids, check.name).toContain(EMPTY_BLOB_TRACK);
      expect(check.sample_ids, check.name).toContain(NULL_BLOB_TRACK);
      expect(check.sample_ids, check.name).not.toContain(REAL_BLOB_TRACK);
    }
  });

  it("is reported as `empty` by get_track_performance, like a NULL one", async () => {
    const empty = await getTrackPerformance(qp, { id: EMPTY_BLOB_TRACK });
    expect(isEngineError(empty)).toBe(false);
    if (isEngineError(empty)) return;
    expect((empty as any).cues.status).toBe("empty");
    expect((empty as any).beatgrid.status).toBe("empty");

    const nul = await getTrackPerformance(qp, { id: NULL_BLOB_TRACK });
    expect(isEngineError(nul)).toBe(false);
    if (isEngineError(nul)) return;
    expect((nul as any).cues.status).toBe("empty");
  });
});
