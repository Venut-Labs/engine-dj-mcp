import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { makeLibrary, addPlaylists, damageChain, reoriginTracks } from "./fixtures/gen-library.js";
import {
  addTracksToPlaylist,
  removeTracksFromPlaylist,
  reorderPlaylist,
  resetSessionSnapshots,
} from "../src/store/write.js";
import { AddTracksToPlaylistInput } from "../src/tools/write-playlist.js";
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

/**
 * Same fixture, but position 2's entry carries an origin pair -- a made-up
 * databaseUuid paired with a trackId no track in this library was ever
 * re-originated to -- that resolves to no local Track at all. This is the
 * only shape that can exercise expectTrackIds: null, which is not "no
 * expectation" but "expect this slot to resolve to nothing".
 */
function setupUnresolvable() {
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
        { id: 2, trackId: 9999, next: 3, databaseUuid: "ghost-uuid" },
        { id: 3, trackId: 3, next: 0 },
      ],
    },
  ]);
  return { dir, dbPath, backupDir: join(dir, "backups") };
}

/**
 * Same fixture, but two Track rows carry one origin pair, and the playlist
 * already holds an entry naming it.
 *
 * The generated schema copies Engine's `C_path` UNIQUE and not the real
 * library's `C_originDatabaseUuid_originTrackId`, so it can hold this state;
 * a library that has been re-originated partway is where it comes from. It
 * is the one shape that tells the two forms of the duplicate check apart --
 * comparing origin pairs, which is what the INSERT and its UNIQUE constraint
 * compare, versus resolving each entry back through `Track` to a local id,
 * which has to pick one of the two rows and misses the other.
 */
function setupSharedOrigin() {
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
        { id: 2, trackId: 42, next: 3, databaseUuid: "shared-uuid" },
        { id: 3, trackId: 3, next: 0 },
      ],
    },
  ]);
  reoriginTracks(dbPath, [
    { id: 5, originUuid: "shared-uuid", originTrackId: 42 },
    { id: 6, originUuid: "shared-uuid", originTrackId: 42 },
  ]);
  return { dir, dbPath, backupDir: join(dir, "backups") };
}

/**
 * Playlist 1 is a *folder*: playlist 2 sits under it. Engine has no separate
 * folder type -- `is_folder` is computed as "has child lists" -- so a folder
 * can carry entries of its own, and the edit tools do not treat it specially.
 */
function setupFolder() {
  const dir = mkdtempSync(join(tmpdir(), "pe-"));
  dirs.push(dir);
  const dbPath = makeLibrary(dir, { tracks: 8, uuid: "lib-uuid" });
  addPlaylists(dbPath, [
    {
      id: 1,
      title: "Crate",
      nextListId: 0,
      entries: [
        { id: 1, trackId: 1, next: 2 },
        { id: 2, trackId: 2, next: 3 },
        { id: 3, trackId: 3, next: 0 },
      ],
    },
    { id: 2, title: "Inside", parentId: 1, nextListId: 0, entries: [{ id: 4, trackId: 4, next: 0 }] },
  ]);
  return { dir, dbPath, backupDir: join(dir, "backups") };
}

/** A single playlist of `n` entries, id and trackId both 1..n, chained in order. */
function setupChain(n: number) {
  const dir = mkdtempSync(join(tmpdir(), "pe-"));
  dirs.push(dir);
  const dbPath = makeLibrary(dir, { tracks: n, uuid: "lib-uuid" });
  const entries = Array.from({ length: n }, (_, i) => ({ id: i + 1, trackId: i + 1, next: i + 2 <= n ? i + 2 : 0 }));
  addPlaylists(dbPath, [{ id: 1, title: "Set", nextListId: 0, entries }]);
  return { dir, dbPath, backupDir: join(dir, "backups") };
}

/**
 * Two playlists in one library, so a test can prove a result or an undo
 * step names the playlist it actually ran against rather than a hardcoded
 * `1` -- every other fixture here has exactly one playlist, which cannot
 * tell the two apart.
 */
function setupTwoPlaylists() {
  const dir = mkdtempSync(join(tmpdir(), "pe-"));
  dirs.push(dir);
  const dbPath = makeLibrary(dir, { tracks: 8, uuid: "lib-uuid" });
  addPlaylists(dbPath, [
    {
      id: 1,
      title: "Set",
      nextListId: 2,
      entries: [
        { id: 1, trackId: 1, next: 2 },
        { id: 2, trackId: 2, next: 3 },
        { id: 3, trackId: 3, next: 0 },
      ],
    },
    {
      id: 2,
      title: "Other",
      nextListId: 0,
      entries: [
        { id: 4, trackId: 4, next: 5 },
        { id: 5, trackId: 5, next: 6 },
        { id: 6, trackId: 6, next: 0 },
      ],
    },
  ]);
  return { dir, dbPath, backupDir: join(dir, "backups") };
}

/** Entry chain of the given list (1 by default), head to tail, as track ids. */
function order(dbPath: string, listId = 1): number[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const rows = db
    .prepare("SELECT id, trackId, nextEntityId FROM PlaylistEntity WHERE listId = ?")
    .all(listId) as any[];
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

  it("returns an undo that names the positions it wrote, and the tracks it put there", async () => {
    const { dbPath, backupDir } = setup();
    const r: any = await addTracksToPlaylist(dbPath, "lib-uuid", { listId: 1, trackIds: [6, 5], at: "end" }, { backupDir });
    expect(r.undo).toEqual([
      {
        tool: "remove_tracks_from_playlist",
        arguments: { playlist_id: 1, positions: [4, 5], expect_track_ids: [6, 5] },
      },
    ]);
    expect(r.undo_complete).toBe(true);
  });

  it("hands back an undo that refuses to run against a list that changed underneath it", async () => {
    // The moment the undo is built is the only moment the server knows which
    // tracks landed at those positions. Without expect_track_ids the undo is
    // just "remove position 4", which a list someone has since prepended to
    // answers with a different track entirely -- silently, and with the
    // caller believing their edit was reversed.
    const { dbPath, backupDir } = setup();
    const r: any = await addTracksToPlaylist(dbPath, "lib-uuid", { listId: 1, trackIds: [6], at: "end" }, { backupDir });
    expect(order(dbPath)).toEqual([1, 2, 3, 6]);

    // Somebody else edits the playlist before the undo is replayed: position
    // 4 now holds track 3, not the track this edit added.
    await addTracksToPlaylist(dbPath, "lib-uuid", { listId: 1, trackIds: [7], at: "start" }, { backupDir });
    expect(order(dbPath)).toEqual([7, 1, 2, 3, 6]);

    const step = r.undo[0];
    const back = await removeTracksFromPlaylist(
      dbPath,
      "lib-uuid",
      { listId: 1, positions: step.arguments.positions, expectTrackIds: step.arguments.expect_track_ids },
      { backupDir },
    );
    expect(isEngineError(back)).toBe(true);
    expect((back as any).error).toBe("invalid_position");
    expect(order(dbPath)).toEqual([7, 1, 2, 3, 6]);
  });

  it("refuses a track whose origin pair is already an entry, even when two tracks share that pair", async () => {
    // The duplicate check compares origin pairs, which is the comparison
    // UNIQUE (listId, databaseUuid, trackId) will make when the INSERT runs.
    // Resolving each entry back to a local track instead asks a different
    // question, through a table that does not promise the pair is unique:
    // with tracks 5 and 6 both carrying ("shared-uuid", 42), it resolves to
    // whichever row the query happens to return, so a request naming the
    // other one slips past, copies a snapshot, opens a transaction and is
    // refused only by the constraint. Both are checked here precisely so the
    // test does not depend on which of the two SQLite returns first.
    for (const trackId of [5, 6]) {
      const { dbPath, backupDir } = setupSharedOrigin();
      const r = await addTracksToPlaylist(dbPath, "lib-uuid", { listId: 1, trackIds: [trackId], at: "end" }, { backupDir });
      expect(isEngineError(r), `track ${trackId}`).toBe(true);
      expect((r as any).error, `track ${trackId}`).toBe("duplicate_track");
      expect((r as any).detail, `track ${trackId}`).toBe("not_committed");
      // The point of the pair form: refused before anything touched the
      // filesystem. The constraint would refuse too, one snapshot later.
      expect(existsSync(backupDir), `track ${trackId}`).toBe(false);
      expect(order(dbPath), `track ${trackId}`).toEqual([1, 42, 3]);
    }
  });

  it("adds to a playlist that is a folder, because Engine has no separate folder type", async () => {
    // A folder is just a playlist other playlists sit under -- there is no
    // flag distinguishing them (see get_playlists's is_folder, which is
    // computed as "has children"). Engine itself shows such a list's own
    // entries, and nothing here refuses one. Pinned rather than argued for:
    // if this ever becomes a refusal it should be a decision, not a drift.
    const { dbPath, backupDir } = setupFolder();
    const r = await addTracksToPlaylist(dbPath, "lib-uuid", { listId: 1, trackIds: [6], at: "end" }, { backupDir });
    expect(isEngineError(r)).toBe(false);
    expect(order(dbPath, 1)).toEqual([1, 2, 3, 6]);
    expect(order(dbPath, 2)).toEqual([4]);
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
    // post-edit check is the only thing that would notice.
    //
    // library_unreadable, not playlist_chain_damaged, and the same code add
    // and reorder return from their own post-edit check: the two codes
    // answer different questions. playlist_chain_damaged means the chain was
    // already broken before this edit and the edit refused to touch it;
    // library_unreadable here means this edit's own verification disagreed
    // with what it wrote and rolled back.
    const { dbPath, backupDir } = setup();
    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE PlaylistEntity SET trackId = 0 WHERE id = 2").run();
    db.close();
    const r = await removeTracksFromPlaylist(dbPath, "lib-uuid", { listId: 1, positions: [2] }, { backupDir });
    expect(isEngineError(r)).toBe(true);
    expect((r as any).error).toBe("library_unreadable");
    expect((r as any).detail).toBe("not_committed");
    expect(order(dbPath)).toEqual([1, 0, 3]);
  });

  it("checks the surviving order, not just that some sound chain is left", async () => {
    // The gate answers "is this still one sound chain", which is not the
    // question the caller asked. Engine's own trigger cannot produce a sound
    // chain holding the wrong entries -- given a sound chain going in, its
    // WHEN OLD.trackId > 0 either relinks correctly or leaves a dangling
    // link, both of which the gate alone catches -- so the divergence is
    // staged here with a trigger of this test's own, which is exactly the
    // shape "a trigger this code does not know about" takes on a file the
    // server does not own.
    {
      // Sound, complete, and in the wrong order: 1 -> 4 -> 3 rather than the
      // 1 -> 3 -> 4 removing position 2 should leave.
      const { dbPath, backupDir } = setupChain(4);
      const db = new DatabaseSync(dbPath);
      db.exec(`CREATE TRIGGER t_scramble AFTER DELETE ON PlaylistEntity FOR EACH ROW BEGIN
        UPDATE PlaylistEntity SET nextEntityId = 4 WHERE id = 1;
        UPDATE PlaylistEntity SET nextEntityId = 3 WHERE id = 4;
        UPDATE PlaylistEntity SET nextEntityId = 0 WHERE id = 3;
      END`);
      db.close();
      const r = await removeTracksFromPlaylist(dbPath, "lib-uuid", { listId: 1, positions: [2] }, { backupDir });
      expect(isEngineError(r)).toBe(true);
      expect((r as any).error).toBe("library_unreadable");
      expect((r as any).detail).toBe("not_committed");
      expect(order(dbPath)).toEqual([1, 2, 3, 4]);
    }
    {
      // Sound, in order, and one entry short: the count is part of the
      // answer too.
      const { dbPath, backupDir } = setupChain(4);
      const db = new DatabaseSync(dbPath);
      db.exec(`CREATE TRIGGER t_extra AFTER DELETE ON PlaylistEntity FOR EACH ROW WHEN OLD.id = 2 BEGIN
        DELETE FROM PlaylistEntity WHERE id = 4;
        UPDATE PlaylistEntity SET nextEntityId = 0 WHERE id = 3;
      END`);
      db.close();
      const r = await removeTracksFromPlaylist(dbPath, "lib-uuid", { listId: 1, positions: [2] }, { backupDir });
      expect(isEngineError(r)).toBe(true);
      expect((r as any).error).toBe("library_unreadable");
      expect(order(dbPath)).toEqual([1, 2, 3, 4]);
    }
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
    // Everything removed here can come back, so the undo is the whole way back.
    expect(r.undo_complete).toBe(true);
    expect(r.undo_note).toBeUndefined();
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

  it("refuses an empty positions list", async () => {
    const { dbPath, backupDir } = setup();
    const r = await removeTracksFromPlaylist(dbPath, "lib-uuid", { listId: 1, positions: [] }, { backupDir });
    expect((r as any).error).toBe("invalid_argument");
    expect((r as any).detail).toBe("not_committed");
    expect(order(dbPath)).toEqual([1, 2, 3]);
  });

  it("treats expectTrackIds: null as the expectation for an entry with no local track", async () => {
    // null there is not "no expectation" -- it is "this slot should resolve
    // to no local track", the same status the response's own removed[].track_id
    // reports for such an entry. A non-null value at that slot must be
    // refused exactly like a wrong id anywhere else would be.
    {
      const { dbPath, backupDir } = setupUnresolvable();
      const r: any = await removeTracksFromPlaylist(dbPath, "lib-uuid", { listId: 1, positions: [2] }, { backupDir });
      expect(isEngineError(r)).toBe(false);
      expect(r.removed).toEqual([{ position: 2, track_id: null }]);
    }
    {
      const { dbPath, backupDir } = setupUnresolvable();
      const r = await removeTracksFromPlaylist(
        dbPath, "lib-uuid", { listId: 1, positions: [2], expectTrackIds: [null] }, { backupDir },
      );
      expect(isEngineError(r)).toBe(false);
    }
    {
      const { dbPath, backupDir } = setupUnresolvable();
      const r = await removeTracksFromPlaylist(
        dbPath, "lib-uuid", { listId: 1, positions: [2], expectTrackIds: [5] }, { backupDir },
      );
      expect((r as any).error).toBe("invalid_position");
      expect(order(dbPath)).toEqual([1, 9999, 3]);
    }
  });

  it("says so instead of promising an undo it cannot execute", async () => {
    // An entry whose stored origin pair names no track in this library has
    // no track id to hand back, and the DELETE destroyed the only place that
    // pair was written down. The undo used to name it anyway, as
    // `track_ids: [null]` -- a step add_tracks_to_playlist's own schema
    // rejects, and which the store would answer with "No track with id null
    // in this library" if it ever got that far. The honest answer is fewer
    // steps and a flag saying so.
    {
      const { dbPath, backupDir } = setupUnresolvable();
      const r: any = await removeTracksFromPlaylist(dbPath, "lib-uuid", { listId: 1, positions: [2] }, { backupDir });
      expect(isEngineError(r)).toBe(false);
      expect(r.removed).toEqual([{ position: 2, track_id: null }]);
      expect(r.undo).toEqual([]);
      expect(r.undo_complete).toBe(false);
      expect(r.undo_note).toMatch(/2/);
      expect(r.undo_note).toMatch(/backup_path/);
    }
    {
      // Mixed: position 2 cannot come back, position 3 can. Every step that
      // *is* emitted must be a call the tool accepts and executes, and the
      // positions must account for the entry that will never return -- an
      // `after_position: 2` computed as if it had would name a position the
      // shortened list does not reach.
      const { dbPath, backupDir } = setupUnresolvable();
      const r: any = await removeTracksFromPlaylist(dbPath, "lib-uuid", { listId: 1, positions: [2, 3] }, { backupDir });
      expect(isEngineError(r)).toBe(false);
      expect(order(dbPath)).toEqual([1]);
      expect(r.undo_complete).toBe(false);
      expect(r.undo).toEqual([
        { tool: "add_tracks_to_playlist", arguments: { playlist_id: 1, track_ids: [3], at: { after_position: 1 } } },
      ]);
      for (const step of r.undo) {
        // The step has to survive the schema its own tool validates against:
        // `track_ids: [null]` did not, which is how an undo nobody could run
        // shipped.
        expect(AddTracksToPlaylistInput.safeParse(step.arguments).success).toBe(true);
        const back = await addTracksToPlaylist(
          dbPath,
          "lib-uuid",
          { listId: 1, trackIds: step.arguments.track_ids, at: step.arguments.at },
          { backupDir },
        );
        expect(isEngineError(back), JSON.stringify(back)).toBe(false);
      }
      // Everything that could come back did, in its original relative order.
      expect(order(dbPath)).toEqual([1, 3]);
    }
  });

  it("orders the undo correctly for two adjacent removals", async () => {
    const { dbPath, backupDir } = setupChain(5);
    const r: any = await removeTracksFromPlaylist(dbPath, "lib-uuid", { listId: 1, positions: [2, 3] }, { backupDir });
    expect(isEngineError(r)).toBe(false);
    expect(order(dbPath)).toEqual([1, 4, 5]);
    expect(r.undo).toEqual([
      { tool: "add_tracks_to_playlist", arguments: { playlist_id: 1, track_ids: [2], at: { after_position: 1 } } },
      { tool: "add_tracks_to_playlist", arguments: { playlist_id: 1, track_ids: [3], at: { after_position: 2 } } },
    ]);
    // The undo is not just the right shape -- replaying it actually
    // reconstructs the original order.
    for (const step of r.undo) {
      await addTracksToPlaylist(dbPath, "lib-uuid", { listId: 1, trackIds: step.arguments.track_ids, at: step.arguments.at }, { backupDir });
    }
    expect(order(dbPath)).toEqual([1, 2, 3, 4, 5]);
  });

  it("orders the undo correctly for three simultaneous removals", async () => {
    const { dbPath, backupDir } = setupChain(5);
    const r: any = await removeTracksFromPlaylist(
      dbPath, "lib-uuid", { listId: 1, positions: [1, 3, 5] }, { backupDir },
    );
    expect(isEngineError(r)).toBe(false);
    expect(order(dbPath)).toEqual([2, 4]);
    expect(r.undo).toEqual([
      { tool: "add_tracks_to_playlist", arguments: { playlist_id: 1, track_ids: [1], at: "start" } },
      { tool: "add_tracks_to_playlist", arguments: { playlist_id: 1, track_ids: [3], at: { after_position: 2 } } },
      { tool: "add_tracks_to_playlist", arguments: { playlist_id: 1, track_ids: [5], at: { after_position: 4 } } },
    ]);
    for (const step of r.undo) {
      await addTracksToPlaylist(dbPath, "lib-uuid", { listId: 1, trackIds: step.arguments.track_ids, at: step.arguments.at }, { backupDir });
    }
    expect(order(dbPath)).toEqual([1, 2, 3, 4, 5]);
  });

  it("names the playlist it actually ran against, not a hardcoded 1", async () => {
    const { dbPath, backupDir } = setupTwoPlaylists();
    const r: any = await removeTracksFromPlaylist(dbPath, "lib-uuid", { listId: 2, positions: [2] }, { backupDir });
    expect(isEngineError(r)).toBe(false);
    expect(r.playlist_id).toBe(2);
    expect(r.undo).toEqual([
      { tool: "add_tracks_to_playlist", arguments: { playlist_id: 2, track_ids: [5], at: { after_position: 1 } } },
    ]);
    expect(order(dbPath, 2)).toEqual([4, 6]);
    expect(order(dbPath, 1)).toEqual([1, 2, 3]);
  });
});

describe("reorderPlaylist", () => {
  it("applies a full permutation", async () => {
    const { dbPath, backupDir } = setup();
    const r = await reorderPlaylist(dbPath, "lib-uuid", { listId: 1, order: [3, 1, 2] }, { backupDir });
    expect(isEngineError(r)).toBe(false);
    expect(order(dbPath)).toEqual([3, 1, 2]);
  });

  it("refuses anything that is not a permutation of 1..n", async () => {
    const { dbPath, backupDir } = setup();
    for (const bad of [[1, 2], [1, 2, 2], [1, 2, 4], [0, 1, 2], [1, 2, 3, 3]]) {
      const r = await reorderPlaylist(dbPath, "lib-uuid", { listId: 1, order: bad }, { backupDir });
      expect((r as any).error, JSON.stringify(bad)).toBe("invalid_position");
      expect(order(dbPath), JSON.stringify(bad)).toEqual([1, 2, 3]);
    }
  });

  it("returns the inverse permutation as its undo", async () => {
    const { dbPath, backupDir } = setup();
    const r: any = await reorderPlaylist(dbPath, "lib-uuid", { listId: 1, order: [3, 1, 2] }, { backupDir });
    expect(r.undo).toEqual([{ tool: "reorder_playlist", arguments: { playlist_id: 1, order: [2, 3, 1] } }]);
    // And it round-trips: applying the undo restores the original order.
    await reorderPlaylist(dbPath, "lib-uuid", { listId: 1, order: [2, 3, 1] }, { backupDir });
    expect(order(dbPath)).toEqual([1, 2, 3]);
  });

  it("does nothing to a permutation that changes nothing", async () => {
    const { dbPath, backupDir } = setup();
    const r = await reorderPlaylist(dbPath, "lib-uuid", { listId: 1, order: [1, 2, 3] }, { backupDir });
    expect(isEngineError(r)).toBe(false);
    expect(order(dbPath)).toEqual([1, 2, 3]);
  });

  it("refuses to touch a damaged chain, and changes nothing", async () => {
    for (const kind of ["cycle", "dangling", "two-heads"] as const) {
      const { dbPath, backupDir } = setup();
      damageChain(dbPath, 1, kind);
      const before = order(dbPath);
      const r = await reorderPlaylist(dbPath, "lib-uuid", { listId: 1, order: [1, 2, 3] }, { backupDir });
      expect(isEngineError(r), kind).toBe(true);
      expect((r as any).error, kind).toBe("playlist_chain_damaged");
      expect((r as any).detail, kind).toBe("not_committed");
      expect(order(dbPath), kind).toEqual(before);
    }
  });

  it("reorders a single-entry playlist as a no-op", async () => {
    const { dbPath, backupDir } = setupChain(1);
    const r = await reorderPlaylist(dbPath, "lib-uuid", { listId: 1, order: [1] }, { backupDir });
    expect(isEngineError(r)).toBe(false);
    expect(order(dbPath)).toEqual([1]);
  });

  it("reorders an empty playlist as a no-op", async () => {
    const { dbPath, backupDir } = setupEmpty();
    const r = await reorderPlaylist(dbPath, "lib-uuid", { listId: 1, order: [] }, { backupDir });
    expect(isEngineError(r)).toBe(false);
    expect(order(dbPath)).toEqual([]);
  });

  it("refuses an unknown playlist", async () => {
    const { dbPath, backupDir } = setup();
    const r = await reorderPlaylist(dbPath, "lib-uuid", { listId: 999, order: [1, 2, 3] }, { backupDir });
    expect((r as any).error).toBe("playlist_not_found");
    expect((r as any).detail).toBe("not_committed");
  });
});
