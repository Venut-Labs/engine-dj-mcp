import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { makeLibrary, addPlaylists, damageChain, reoriginTracks } from "./fixtures/gen-library.js";
import { addTracksToPlaylist, removeTracksFromPlaylist, resetSessionSnapshots } from "../src/store/write.js";
import { isEngineError } from "../src/errors.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  resetSessionSnapshots();
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "pe-"));
  dirs.push(dir);
  const dbPath = makeLibrary(dir, { tracks: 8, uuid: "lib-uuid" });
  addPlaylists(dbPath, [
    {
      id: 1,
      title: "Set",
      nextListId: 0,
      entries: [
        { id: 1, trackId: 1, next: 2 },
        { id: 2, trackId: 2, next: 3 },
        { id: 3, trackId: 3, next: 0 },
      ],
    },
  ]);
  return { dir, dbPath, backupDir: join(dir, "backups") };
}

/** Same fixture, but playlist 1 starts with no entries at all. */
function setupEmpty() {
  const dir = mkdtempSync(join(tmpdir(), "pe-"));
  dirs.push(dir);
  const dbPath = makeLibrary(dir, { tracks: 8, uuid: "lib-uuid" });
  addPlaylists(dbPath, [{ id: 1, title: "Empty", nextListId: 0, entries: [] }]);
  return { dir, dbPath, backupDir: join(dir, "backups") };
}

/** Entry chain of list 1, head to tail, as track ids. */
function order(dbPath: string): number[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const rows = db.prepare("SELECT id, trackId, nextEntityId FROM PlaylistEntity WHERE listId = 1").all() as any[];
  db.close();
  const byId = new Map(rows.map((r) => [r.id, r]));
  const targets = new Set(rows.map((r) => r.nextEntityId));
  let cur = rows.find((r) => !targets.has(r.id));
  const out: number[] = [];
  const seen = new Set<number>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.push(cur.trackId);
    cur = byId.get(cur.nextEntityId);
  }
  return out;
}

describe("addTracksToPlaylist", () => {
  it("appends in the order given", async () => {
    const { dbPath, backupDir } = setup();
    const r = await addTracksToPlaylist(dbPath, "lib-uuid", { listId: 1, trackIds: [6, 5], at: "end" }, { backupDir });
    expect(isEngineError(r)).toBe(false);
    expect(order(dbPath)).toEqual([1, 2, 3, 6, 5]);
    expect((r as any).positions).toEqual([4, 5]);
  });

  it("prepends without touching any other row's link", async () => {
    const { dbPath, backupDir } = setup();
    await addTracksToPlaylist(dbPath, "lib-uuid", { listId: 1, trackIds: [7], at: "start" }, { backupDir });
    expect(order(dbPath)).toEqual([7, 1, 2, 3]);
  });

  it("inserts after a named position", async () => {
    const { dbPath, backupDir } = setup();
    await addTracksToPlaylist(dbPath, "lib-uuid", { listId: 1, trackIds: [8], at: { after_position: 1 } }, { backupDir });
    expect(order(dbPath)).toEqual([1, 8, 2, 3]);
  });

  // A run of more than one track exercises the interior links a single-track
  // insert cannot: with one track, ids[0] === ids[ids.length - 1], so a
  // start/end swap in which end of the run gets linked to the surrounding
  // chain is invisible. These two are the multi-track counterparts of the
  // two splice tests above.
  it("prepends a multi-track run in the order given", async () => {
    const { dbPath, backupDir } = setup();
    const r = await addTracksToPlaylist(dbPath, "lib-uuid", { listId: 1, trackIds: [7, 8], at: "start" }, { backupDir });
    expect(isEngineError(r)).toBe(false);
    expect(order(dbPath)).toEqual([7, 8, 1, 2, 3]);
    expect((r as any).positions).toEqual([1, 2]);
  });

  it("inserts a multi-track run after a named position", async () => {
    const { dbPath, backupDir } = setup();
    const r = await addTracksToPlaylist(
      dbPath, "lib-uuid", { listId: 1, trackIds: [7, 8], at: { after_position: 1 } }, { backupDir },
    );
    expect(isEngineError(r)).toBe(false);
    expect(order(dbPath)).toEqual([1, 7, 8, 2, 3]);
    expect((r as any).positions).toEqual([2, 3]);
  });

  it("adds to an empty playlist, whose old head is nothing", async () => {
    const { dbPath, backupDir } = setupEmpty();
    const r = await addTracksToPlaylist(dbPath, "lib-uuid", { listId: 1, trackIds: [1, 2], at: "start" }, { backupDir });
    expect(isEngineError(r)).toBe(false);
    expect(order(dbPath)).toEqual([1, 2]);
    expect((r as any).positions).toEqual([1, 2]);
  });

  it("refuses to touch a damaged chain, and changes nothing", async () => {
    for (const kind of ["cycle", "dangling", "two-heads"] as const) {
      const { dbPath, backupDir } = setup();
      damageChain(dbPath, 1, kind);
      const before = order(dbPath);
      const r = await addTracksToPlaylist(dbPath, "lib-uuid", { listId: 1, trackIds: [6], at: "end" }, { backupDir });
      expect(isEngineError(r), kind).toBe(true);
      expect((r as any).error, kind).toBe("playlist_chain_damaged");
      expect((r as any).detail, kind).toBe("not_committed");
      expect(order(dbPath), kind).toEqual(before);
    }
  });

  it("refuses a track already in the list, failing fast before any snapshot is taken", async () => {
    // The check's real value is fail-fast: refusing before the snapshot is
    // copied and before a write transaction opens, with a message naming
    // the track, rather than a UNIQUE-constraint violation surfacing from
    // inside a transaction. It is not stronger than that constraint -- see
    // src/store/write.ts's comment on the check itself for the case it
    // cannot catch. What it *can* prove, and the constraint alone cannot,
    // is that none of this ever touched the filesystem: no snapshot copy.
    const { dbPath, backupDir } = setup();
    const r = await addTracksToPlaylist(dbPath, "lib-uuid", { listId: 1, trackIds: [2], at: "end" }, { backupDir });
    expect(isEngineError(r)).toBe(true);
    expect((r as any).error).toBe("duplicate_track");
    expect((r as any).detail).toBe("not_committed");
    expect(existsSync(backupDir)).toBe(false);
    expect(order(dbPath)).toEqual([1, 2, 3]);
  });

  it("updates the playlist's lastEditTime, as a text date", async () => {
    // No trigger does this: changing PlaylistEntity leaves Playlist
    // untouched. Measured before and after a delete -- identical.
    const { dbPath, backupDir } = setup();
    await addTracksToPlaylist(dbPath, "lib-uuid", { listId: 1, trackIds: [6], at: "end" }, { backupDir });
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare("SELECT lastEditTime t, typeof(lastEditTime) ty FROM Playlist WHERE id = 1").get() as any;
    db.close();
    expect(row.ty).toBe("text");
    expect(row.t).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it("returns an undo that names the positions it wrote", async () => {
    const { dbPath, backupDir } = setup();
    const r: any = await addTracksToPlaylist(dbPath, "lib-uuid", { listId: 1, trackIds: [6, 5], at: "end" }, { backupDir });
    expect(r.undo).toEqual([
      { tool: "remove_tracks_from_playlist", arguments: { playlist_id: 1, positions: [4, 5] } },
    ]);
  });

  it("refuses an empty trackIds list", async () => {
    const { dbPath, backupDir } = setup();
    const r = await addTracksToPlaylist(dbPath, "lib-uuid", { listId: 1, trackIds: [], at: "end" }, { backupDir });
    expect((r as any).error).toBe("invalid_argument");
    expect((r as any).detail).toBe("not_committed");
    expect(existsSync(backupDir)).toBe(false);
    expect(order(dbPath)).toEqual([1, 2, 3]);
  });

  it("refuses an unknown playlist", async () => {
    const { dbPath, backupDir } = setup();
    const r = await addTracksToPlaylist(dbPath, "lib-uuid", { listId: 999, trackIds: [6], at: "end" }, { backupDir });
    expect((r as any).error).toBe("playlist_not_found");
    expect((r as any).detail).toBe("not_committed");
  });

  it("refuses a position outside the list", async () => {
    const { dbPath, backupDir } = setup();
    const r = await addTracksToPlaylist(
      dbPath, "lib-uuid", { listId: 1, trackIds: [6], at: { after_position: 99 } }, { backupDir },
    );
    expect((r as any).error).toBe("invalid_position");
  });

  it("refuses after_position 0", async () => {
    const { dbPath, backupDir } = setup();
    const r = await addTracksToPlaylist(
      dbPath, "lib-uuid", { listId: 1, trackIds: [6], at: { after_position: 0 } }, { backupDir },
    );
    expect((r as any).error).toBe("invalid_position");
  });

  it("refuses a negative after_position", async () => {
    const { dbPath, backupDir } = setup();
    const r = await addTracksToPlaylist(
      dbPath, "lib-uuid", { listId: 1, trackIds: [6], at: { after_position: -1 } }, { backupDir },
    );
    expect((r as any).error).toBe("invalid_position");
  });

  it("accepts after_position at the legal boundary, equal to the chain's length", async () => {
    const { dbPath, backupDir } = setup();
    const r = await addTracksToPlaylist(
      dbPath, "lib-uuid", { listId: 1, trackIds: [6], at: { after_position: 3 } }, { backupDir },
    );
    expect(isEngineError(r)).toBe(false);
    expect(order(dbPath)).toEqual([1, 2, 3, 6]);
  });

  it("stores a re-originated track's origin pair, not its local row id", async () => {
    // order() reads PlaylistEntity.trackId directly and agrees with the
    // local id only because the fixture's origin and local id coincide by
    // default. Re-originating one track breaks that coincidence, so this is
    // the only test in the suite that can tell a correct write apart from
    // one that stored the local id -- the bug class this repository has
    // shipped five times.
    const { dbPath, backupDir } = setup();
    reoriginTracks(dbPath, [{ id: 5, originUuid: "other-lib-uuid", originTrackId: 999 }]);
    const r = await addTracksToPlaylist(dbPath, "lib-uuid", { listId: 1, trackIds: [5], at: "end" }, { backupDir });
    expect(isEngineError(r)).toBe(false);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db
      .prepare("SELECT trackId, databaseUuid FROM PlaylistEntity WHERE listId = 1 AND databaseUuid = ?")
      .get("other-lib-uuid") as any;
    db.close();
    expect(row?.trackId).toBe(999);
  });
});

describe("removeTracksFromPlaylist", () => {
  it("removes by position and leaves the chain sound", async () => {
    const { dbPath, backupDir } = setup();
    const r = await removeTracksFromPlaylist(dbPath, "lib-uuid", { listId: 1, positions: [2] }, { backupDir });
    expect(isEngineError(r)).toBe(false);
    expect(order(dbPath)).toEqual([1, 3]);
  });

  it("removes the head and the tail correctly", async () => {
    for (const [pos, left] of [[1, [2, 3]], [3, [1, 2]]] as const) {
      const { dbPath, backupDir } = setup();
      await removeTracksFromPlaylist(dbPath, "lib-uuid", { listId: 1, positions: [pos] }, { backupDir });
      expect(order(dbPath), `position ${pos}`).toEqual([...left]);
    }
  });

  it("catches a chain the delete trigger did not relink", async () => {
    // trigger_before_delete_PlaylistEntity carries WHEN OLD.trackId > 0, so
    // an entry with trackId <= 0 is deleted without relinking and leaves its
    // predecessor pointing at nothing. No real library measured has such a
    // row -- min trackId is 1 -- but "none today" is not "none ever", and the
    // post-edit gate is the only thing that would notice.
    const { dbPath, backupDir } = setup();
    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE PlaylistEntity SET trackId = 0 WHERE id = 2").run();
    db.close();
    const r = await removeTracksFromPlaylist(dbPath, "lib-uuid", { listId: 1, positions: [2] }, { backupDir });
    expect(isEngineError(r)).toBe(true);
    expect((r as any).error).toBe("playlist_chain_damaged");
    expect((r as any).detail).toBe("not_committed");
    expect(order(dbPath)).toEqual([1, 0, 3]);
  });

  it("returns an ordered undo, because positions shift as it runs", async () => {
    const { dbPath, backupDir } = setup();
    const r: any = await removeTracksFromPlaylist(dbPath, "lib-uuid", { listId: 1, positions: [1, 3] }, { backupDir });
    // Restoring position 1 first puts the later one back at 3; restoring 3
    // first would land the other at 2. The order is part of the answer.
    expect(r.undo).toEqual([
      { tool: "add_tracks_to_playlist", arguments: { playlist_id: 1, track_ids: [1], at: "start" } },
      { tool: "add_tracks_to_playlist", arguments: { playlist_id: 1, track_ids: [3], at: { after_position: 2 } } },
    ]);
  });

  it("checks expect_track_ids when given, and refuses a mismatch", async () => {
    const { dbPath, backupDir } = setup();
    const r = await removeTracksFromPlaylist(
      dbPath, "lib-uuid", { listId: 1, positions: [2], expectTrackIds: [3] }, { backupDir },
    );
    expect((r as any).error).toBe("invalid_position");
    expect(order(dbPath)).toEqual([1, 2, 3]);
  });

  it("refuses a repeated or out-of-range position", async () => {
    const { dbPath, backupDir } = setup();
    for (const positions of [[2, 2], [0], [4]]) {
      const r = await removeTracksFromPlaylist(dbPath, "lib-uuid", { listId: 1, positions }, { backupDir });
      expect((r as any).error, JSON.stringify(positions)).toBe("invalid_position");
    }
  });
});
