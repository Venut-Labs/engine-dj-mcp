import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { makeLibrary, addPlaylists, damageChain } from "./fixtures/gen-library.js";
import { addTracksToPlaylist, resetSessionSnapshots } from "../src/store/write.js";
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
});
