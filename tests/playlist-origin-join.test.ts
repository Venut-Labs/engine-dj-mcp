import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLibrary, addPlaylists, reoriginTracks } from "./fixtures/gen-library.js";
import { readLibraryInfo } from "../src/discovery.js";
import { QueryProcess } from "../src/proc/query-client.js";
import { IndexManager } from "../src/store/index-manager.js";
import { getPlaylistTracks } from "../src/tools/playlists.js";
import { auditLibrary } from "../src/tools/audit.js";
import { isEngineError } from "../src/errors.js";

/**
 * A playlist entry names a track by `(databaseUuid, trackId)` -- the identity
 * the track had in the library it came from -- not by the local row id. Engine
 * itself joins on that pair; the query is embedded in its own binary.
 *
 * Every other fixture in this suite generates tracks whose originTrackId
 * equals their id and whose originDatabaseUuid is the library's own, so a join
 * on `e.trackId = t.id` and the correct one agree and nothing can tell them
 * apart. On a real library they do not agree: 178 of 202 entries referenced a
 * third database, and the wrong join reported 105 orphans where there were
 * none, turning a complete 43-track playlist into 42 holes.
 *
 * This file is the fixture that can fail. Patch the join back to
 * `t.id = e.trackId` and these tests must go red.
 */
const FOREIGN = "11111111-2222-4333-8444-555555555555";
let dir: string, mdb: string, qp: QueryProcess;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "edj-origin-"));
  mdb = makeLibrary(dir, { tracks: 40 });

  // Track 7 keeps its row id but claims a foreign origin; track 8 stays local
  // yet is renumbered, so neither can be reached by matching the row id.
  reoriginTracks(mdb, [
    { id: 7, originUuid: FOREIGN, originTrackId: 90_007 },
    { id: 8, originUuid: FOREIGN, originTrackId: 90_008 },
  ]);

  addPlaylists(mdb, [
    {
      id: 70,
      title: "Imported",
      nextListId: 0,
      entries: [
        { id: 700, trackId: 90_007, databaseUuid: FOREIGN, next: 701 },
        { id: 701, trackId: 90_008, databaseUuid: FOREIGN, next: 702 },
        // A genuine orphan: that pair matches no track anywhere.
        { id: 702, trackId: 90_404, databaseUuid: FOREIGN, next: 0 },
      ],
    },
  ]);

  const lib = readLibraryInfo(mdb);
  if (isEngineError(lib)) throw new Error("fixture unreadable");
  qp = new QueryProcess(mdb, null, 10_000);
  await new IndexManager(lib, qp, join(dir, "sidecars")).ensureFresh();
});

afterAll(() => {
  qp.dispose();
  rmSync(dir, { recursive: true, force: true });
});

describe("playlist entries resolve by origin identity, not row id", () => {
  it("finds imported tracks whose origin id differs from their row id", async () => {
    const r = await getPlaylistTracks(qp, { playlist_id: 70, fields: ["id", "title"] });
    if (isEngineError(r)) throw new Error(JSON.stringify(r));

    expect(r.entry_count).toBe(3);
    // Two of the three resolve. Under `t.id = e.trackId` none would: 90007 and
    // 90008 are not row ids, so all three would come back as holes.
    expect(r.missing_count).toBe(1);
    expect(r.tracks[0]).toMatchObject({ position: 1, id: 7 });
    expect(r.tracks[1]).toMatchObject({ position: 2, id: 8 });
    expect(r.tracks[2]).toMatchObject({ position: 3, missing: true });
  });

  it("counts only the genuinely unresolvable entry as an orphan", async () => {
    const r = await auditLibrary(qp, mdb, { checks: ["orphan_entries"] });
    if (isEngineError(r)) throw new Error(JSON.stringify(r));
    // One, not three: an imported track is not a missing one.
    expect(r.checks[0]!.count).toBe(1);
  });
});
