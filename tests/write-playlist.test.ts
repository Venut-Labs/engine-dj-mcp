import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { makeLibrary, addPlaylists, reoriginTracks } from "./fixtures/gen-library.js";
import { createPlaylist } from "../src/store/write.js";
import { isEngineError } from "../src/errors.js";

/** Walk the entry chain the way Engine does, from the head we are told. */
function chain(dbPath: string, listId: number): { trackId: number; uuid: string }[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const rows = db
    .prepare("SELECT id, trackId, databaseUuid, nextEntityId FROM PlaylistEntity WHERE listId = ?")
    .all(listId) as any[];
  db.close();
  const byId = new Map(rows.map((r) => [r.id, r]));
  const targets = new Set(rows.map((r) => r.nextEntityId));
  let cur = rows.find((r) => !targets.has(r.id));
  const out: { trackId: number; uuid: string }[] = [];
  const seen = new Set<number>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.push({ trackId: cur.trackId, uuid: cur.databaseUuid });
    cur = byId.get(cur.nextEntityId);
  }
  return out;
}

function setup(opts: { tracks?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "wr-"));
  const dbPath = makeLibrary(dir, { tracks: opts.tracks ?? 6, uuid: "lib-uuid" });
  // PlaylistSpec has no trackIds shorthand -- id, nextListId and each entry's
  // chain link are given explicitly, the same as any other fixture playlist.
  addPlaylists(dbPath, [
    {
      id: 1,
      title: "Existing",
      nextListId: 0,
      entries: [
        { id: 1, trackId: 1, next: 2 },
        { id: 2, trackId: 2, next: 0 },
      ],
    },
  ]);
  return { dir, dbPath, backupDir: join(dir, "backups") };
}

describe("createPlaylist", () => {
  it("writes the entries in the order given, not in id order", async () => {
    const { dir, dbPath, backupDir } = setup();
    const r = await createPlaylist(dbPath, "lib-uuid", { title: "Set", trackIds: [5, 2, 4] }, { backupDir });
    expect(isEngineError(r)).toBe(false);
    const ok = r as any;
    expect(ok.tracks_added).toBe(3);
    expect(chain(dbPath, ok.playlist_id).map((e) => e.trackId)).toEqual([5, 2, 4]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("stores the track's origin identity, not its local row id", async () => {
    // The bug this whole contract exists to prevent. With originTrackId = id
    // -- true of every track in both real libraries -- a writer using the
    // local id passes. Re-originating the rows is what makes the two differ.
    const { dir, dbPath, backupDir } = setup();
    reoriginTracks(dbPath, [
      { id: 3, originUuid: "other-lib", originTrackId: 903 },
      { id: 4, originUuid: "other-lib", originTrackId: 904 },
    ]);
    const r = await createPlaylist(dbPath, "lib-uuid", { title: "Origins", trackIds: [3, 4] }, { backupDir });
    expect(isEngineError(r)).toBe(false);
    expect(chain(dbPath, (r as any).playlist_id)).toEqual([
      { trackId: 903, uuid: "other-lib" },
      { trackId: 904, uuid: "other-lib" },
    ]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("appends to the playlist chain, relinking the previous tail", async () => {
    const { dir, dbPath, backupDir } = setup();
    const db0 = new DatabaseSync(dbPath, { readOnly: true });
    const before = (db0.prepare("SELECT id FROM Playlist WHERE nextListId = 0").get() as any).id;
    db0.close();

    const r = await createPlaylist(dbPath, "lib-uuid", { title: "Tail", trackIds: [1] }, { backupDir });
    const id = (r as any).playlist_id;

    const db = new DatabaseSync(dbPath, { readOnly: true });
    expect((db.prepare("SELECT nextListId FROM Playlist WHERE id = ?").get(before) as any).nextListId).toBe(id);
    expect((db.prepare("SELECT COUNT(*) c FROM Playlist WHERE nextListId = 0").get() as any).c).toBe(1);
    expect((db.prepare("SELECT id FROM Playlist WHERE nextListId = 0").get() as any).id).toBe(id);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes lastEditTime as a text date, the way Engine does for playlists", async () => {
    // Track.lastEditTime is a Unix epoch integer and Playlist.lastEditTime is
    // not. Engine renders a playlist carrying the wrong one without complaint,
    // so only this assertion catches it.
    const { dir, dbPath, backupDir } = setup();
    const r = await createPlaylist(dbPath, "lib-uuid", { title: "Stamp", trackIds: [1] }, { backupDir });
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db
      .prepare("SELECT lastEditTime t, typeof(lastEditTime) ty FROM Playlist WHERE id = ?")
      .get((r as any).playlist_id) as any;
    db.close();
    expect(row.ty).toBe("text");
    expect(row.t).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates an empty playlist when given no tracks", async () => {
    const { dir, dbPath, backupDir } = setup();
    const r = await createPlaylist(dbPath, "lib-uuid", { title: "Empty", trackIds: [] }, { backupDir });
    expect(isEngineError(r)).toBe(false);
    expect((r as any).tracks_added).toBe(0);
    expect(chain(dbPath, (r as any).playlist_id)).toEqual([]);
    // chain() returns [] whether or not the Playlist row exists at all, so an
    // implementation that skipped the insert and invented an id would pass
    // the assertion above. Confirm the row is actually there.
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare("SELECT title FROM Playlist WHERE id = ?").get((r as any).playlist_id) as any;
    db.close();
    expect(row?.title).toBe("Empty");
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes the mandated column values, not just whatever happens to work", async () => {
    // These are specified by exact value, not "truthy" or "falsy" -- a
    // writer that flipped isPersisted or left isExplicitlyExported unset
    // would still produce a playlist Engine renders, so nothing but a direct
    // readback catches a wrong constant here.
    const { dir, dbPath, backupDir } = setup();
    const r = await createPlaylist(dbPath, "lib-uuid", { title: "Constants", trackIds: [1, 2] }, { backupDir });
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const list = db
      .prepare("SELECT parentListId, isPersisted, isExplicitlyExported FROM Playlist WHERE id = ?")
      .get((r as any).playlist_id) as any;
    const entries = db
      .prepare("SELECT membershipReference FROM PlaylistEntity WHERE listId = ?")
      .all((r as any).playlist_id) as any[];
    db.close();
    expect(list).toEqual({ parentListId: 0, isPersisted: 1, isExplicitlyExported: 0 });
    expect(entries.length).toBe(2);
    expect(entries.every((e) => e.membershipReference === 0)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a duplicate title with playlist_exists and writes nothing", async () => {
    const { dir, dbPath, backupDir } = setup();
    const r = await createPlaylist(dbPath, "lib-uuid", { title: "Existing", trackIds: [1] }, { backupDir });
    expect(isEngineError(r)).toBe(true);
    expect((r as any).error).toBe("playlist_exists");
    expect((r as any).detail).toBe("not_committed");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    expect((db.prepare("SELECT COUNT(*) c FROM Playlist").get() as any).c).toBe(1);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses an unknown track id and leaves no partial playlist behind", async () => {
    const { dir, dbPath, backupDir } = setup();
    const r = await createPlaylist(dbPath, "lib-uuid", { title: "Ghost", trackIds: [1, 9999] }, { backupDir });
    expect(isEngineError(r)).toBe(true);
    expect((r as any).error).toBe("unknown_track");
    expect((r as any).detail).toBe("not_committed");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    expect((db.prepare("SELECT COUNT(*) c FROM Playlist WHERE title='Ghost'").get() as any).c).toBe(0);
    expect((db.prepare("SELECT COUNT(*) c FROM PlaylistEntity").get() as any).c).toBe(2);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses the same track twice rather than tripping the UNIQUE constraint", async () => {
    const { dir, dbPath, backupDir } = setup();
    const r = await createPlaylist(dbPath, "lib-uuid", { title: "Dup", trackIds: [2, 3, 2] }, { backupDir });
    expect(isEngineError(r)).toBe(true);
    expect((r as any).error).toBe("duplicate_track");
    expect((r as any).detail).toBe("not_committed");
    rmSync(dir, { recursive: true, force: true });
  });

  it("rolls back every row when a later entity insert hits the real UNIQUE constraint", async () => {
    // resolveOrigins only catches a *repeated* id within one request, so it
    // runs before any row exists and its rollback path is untested by the
    // two error cases above: delete every ROLLBACK call and those still
    // pass. This forces a genuine PlaylistEntity UNIQUE(listId, databaseUuid,
    // trackId) violation from a row already sitting in the table, which is
    // only caught after the Playlist row and one PlaylistEntity row have
    // actually been inserted -- so it is the one test that can tell "wrote
    // nothing" apart from "wrote it, then failed to say so".
    const { dir, dbPath, backupDir } = setup();
    // FK enforcement is on by default for a plain DatabaseSync connection
    // (node:sqlite's own default, separate from createPlaylist's explicit
    // PRAGMA). Off here because this seed row deliberately targets a listId
    // that does not exist yet -- the id the next Playlist insert will get.
    const seed = new DatabaseSync(dbPath, { enableForeignKeyConstraints: false });
    const nextListId = (seed.prepare("SELECT MAX(id) + 1 AS n FROM Playlist").get() as any).n;
    // Track 1 was never re-originated, so its origin pair is exactly
    // (lib-uuid, 1) -- what createPlaylist will try to insert as the second
    // entity row below, once the fresh Playlist row lands on `nextListId`.
    seed
      .prepare(
        "INSERT INTO PlaylistEntity (listId, trackId, databaseUuid, nextEntityId, membershipReference) VALUES (?, 1, 'lib-uuid', 0, 0)",
      )
      .run(nextListId);
    const playlistCountBefore = (seed.prepare("SELECT COUNT(*) c FROM Playlist").get() as any).c;
    const entityCountBefore = (seed.prepare("SELECT COUNT(*) c FROM PlaylistEntity").get() as any).c;
    seed.close();

    const r = await createPlaylist(dbPath, "lib-uuid", { title: "Collide", trackIds: [2, 1] }, { backupDir });
    expect(isEngineError(r)).toBe(true);
    expect((r as any).error).toBe("duplicate_track");
    expect((r as any).detail).toBe("not_committed");

    const db = new DatabaseSync(dbPath, { readOnly: true });
    expect((db.prepare("SELECT COUNT(*) c FROM Playlist").get() as any).c).toBe(playlistCountBefore);
    expect((db.prepare("SELECT COUNT(*) c FROM PlaylistEntity").get() as any).c).toBe(entityCountBefore);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("takes a snapshot and names it in the result", async () => {
    const { dir, dbPath, backupDir } = setup();
    const r = await createPlaylist(dbPath, "lib-uuid", { title: "Backed", trackIds: [1] }, { backupDir });
    const copy = new DatabaseSync((r as any).backup_path, { readOnly: true });
    // The snapshot predates the write, so the new playlist must not be in it.
    expect((copy.prepare("SELECT COUNT(*) c FROM Playlist WHERE title='Backed'").get() as any).c).toBe(0);
    copy.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
