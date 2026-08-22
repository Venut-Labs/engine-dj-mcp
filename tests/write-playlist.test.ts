import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, openSync, writeSync, closeSync, existsSync, readdirSync } from "node:fs";
import { fork } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { makeLibrary, addPlaylists, reoriginTracks } from "./fixtures/gen-library.js";
import { createPlaylist, sameOrder, walkFrom } from "../src/store/write.js";
import { isEngineError } from "../src/errors.js";

const hotWriterScript = fileURLToPath(new URL("./fixtures/hot-journal-writer.js", import.meta.url));

// Every temp dir this file makes, cleaned up whether the test passed or not.
// They were removed by a trailing rmSync in each test before, so a failing
// assertion leaked one -- and these hold full copies of a library.
const tempDirs: string[] = [];
afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

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
  tempDirs.push(dir);
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
    const { dbPath, backupDir } = setup();
    const r = await createPlaylist(dbPath, "lib-uuid", { title: "Set", trackIds: [5, 2, 4] }, { backupDir });
    expect(isEngineError(r)).toBe(false);
    const ok = r as any;
    expect(ok.tracks_added).toBe(3);
    expect(chain(dbPath, ok.playlist_id).map((e) => e.trackId)).toEqual([5, 2, 4]);
  });

  it("stores the track's origin identity, not its local row id", async () => {
    // The bug this whole contract exists to prevent. With originTrackId = id
    // -- true of every track in both real libraries -- a writer using the
    // local id passes. Re-originating the rows is what makes the two differ.
    const { dbPath, backupDir } = setup();
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
  });

  it("appends to the playlist chain, relinking the previous tail", async () => {
    const { dbPath, backupDir } = setup();
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
  });

  it("writes lastEditTime as a text date, the way Engine does for playlists", async () => {
    // Track.lastEditTime is a Unix epoch integer and Playlist.lastEditTime is
    // not. Engine renders a playlist carrying the wrong one without complaint,
    // so only this assertion catches it.
    const { dbPath, backupDir } = setup();
    const r = await createPlaylist(dbPath, "lib-uuid", { title: "Stamp", trackIds: [1] }, { backupDir });
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db
      .prepare("SELECT lastEditTime t, typeof(lastEditTime) ty FROM Playlist WHERE id = ?")
      .get((r as any).playlist_id) as any;
    db.close();
    expect(row.ty).toBe("text");
    expect(row.t).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it("creates an empty playlist when given no tracks", async () => {
    const { dbPath, backupDir } = setup();
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
  });

  it("writes the mandated column values, not just whatever happens to work", async () => {
    // These are specified by exact value, not "truthy" or "falsy" -- a
    // writer that flipped isPersisted or left isExplicitlyExported unset
    // would still produce a playlist Engine renders, so nothing but a direct
    // readback catches a wrong constant here.
    const { dbPath, backupDir } = setup();
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
  });

  it("refuses a duplicate title with playlist_exists and writes nothing", async () => {
    const { dbPath, backupDir } = setup();
    const r = await createPlaylist(dbPath, "lib-uuid", { title: "Existing", trackIds: [1] }, { backupDir });
    expect(isEngineError(r)).toBe(true);
    expect((r as any).error).toBe("playlist_exists");
    expect((r as any).detail).toBe("not_committed");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    expect((db.prepare("SELECT COUNT(*) c FROM Playlist").get() as any).c).toBe(1);
    db.close();
  });

  it("refuses an unknown track id and leaves no partial playlist behind", async () => {
    const { dbPath, backupDir } = setup();
    const r = await createPlaylist(dbPath, "lib-uuid", { title: "Ghost", trackIds: [1, 9999] }, { backupDir });
    expect(isEngineError(r)).toBe(true);
    expect((r as any).error).toBe("unknown_track");
    expect((r as any).detail).toBe("not_committed");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    expect((db.prepare("SELECT COUNT(*) c FROM Playlist WHERE title='Ghost'").get() as any).c).toBe(0);
    expect((db.prepare("SELECT COUNT(*) c FROM PlaylistEntity").get() as any).c).toBe(2);
    db.close();
  });

  it("refuses the same track twice rather than tripping the UNIQUE constraint", async () => {
    const { dbPath, backupDir } = setup();
    const r = await createPlaylist(dbPath, "lib-uuid", { title: "Dup", trackIds: [2, 3, 2] }, { backupDir });
    expect(isEngineError(r)).toBe(true);
    expect((r as any).error).toBe("duplicate_track");
    expect((r as any).detail).toBe("not_committed");
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
    const { dbPath, backupDir } = setup();
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
  });

  it("takes a snapshot and names it in the result", async () => {
    const { dbPath, backupDir } = setup();
    const r = await createPlaylist(dbPath, "lib-uuid", { title: "Backed", trackIds: [1] }, { backupDir });
    const copy = new DatabaseSync((r as any).backup_path, { readOnly: true });
    // The snapshot predates the write, so the new playlist must not be in it.
    expect((copy.prepare("SELECT COUNT(*) c FROM Playlist WHERE title='Backed'").get() as any).c).toBe(0);
    copy.close();
  });

  it("returns an EngineError, not a rejection, when the library disappears before the write", async () => {
    // Everything up to and including the title/track pre-check ran through a
    // try with no catch until this round -- a missing file, an unmounted
    // volume, or Engine holding the lock would all throw straight out of
    // createPlaylist instead of resolving to an EngineError.
    const { dir, backupDir } = setup();
    const r = await createPlaylist(join(dir, "nope", "m.db"), "lib-uuid", { title: "X", trackIds: [] }, { backupDir });
    expect(isEngineError(r)).toBe(true);
    expect((r as any).error).toBe("library_not_found");
    expect((r as any).detail).toBe("not_committed");
  });

  it("labels a pre-write snapshot failure as not_committed too", async () => {
    // snapshotLibrary itself sets no detail (src/store/backup.ts); this
    // confirms createPlaylist adds one on the way through rather than
    // leaving this the one pre-commit error the discriminator misses.
    const { dbPath } = setup();
    // A file where the backup directory needs to be gives mkdirSync ENOTDIR.
    const backupDir = join(dbPath, "not-a-directory");
    const r = await createPlaylist(dbPath, "lib-uuid", { title: "X", trackIds: [] }, { backupDir });
    expect(isEngineError(r)).toBe(true);
    expect((r as any).detail).toBe("not_committed");
  });

  it("reports a committed write that then fails its own check, with a usable backup_path", async () => {
    // The corruption does not need to land between COMMIT and the check: a
    // pre-existing bad page in a table this write never touches is enough.
    // BEGIN IMMEDIATE / INSERT / COMMIT all succeed and persist -- only the
    // post-commit PRAGMA quick_check, which walks every page rather than
    // just the ones this transaction wrote, ever notices.
    const { dbPath, backupDir } = setup();

    // A throwaway table, so corrupting its one page cannot touch anything
    // createPlaylist itself reads or writes.
    const seed = new DatabaseSync(dbPath);
    seed.exec("CREATE TABLE Junk (id INTEGER PRIMARY KEY, data TEXT)");
    seed.prepare("INSERT INTO Junk (data) VALUES (?)").run("x".repeat(100));
    const pageSize = (seed.prepare("PRAGMA page_size").get() as any).page_size as number;
    const rootpage = (
      seed.prepare("SELECT rootpage FROM sqlite_master WHERE name = 'Junk'").get() as any
    ).rootpage as number;
    seed.close();

    // Smash the b-tree page header (page type, freeblock pointer, cell
    // count, content-area start) so SQLite can no longer parse this page as
    // a b-tree at all. Confirmed against a throwaway probe that this is what
    // makes quick_check fail with "btreeInitPage() returns error code 11" --
    // scrambling row payload bytes further into the page instead left
    // quick_check reporting "ok", because it validates b-tree structure, not
    // row content.
    const fd = openSync(dbPath, "r+");
    writeSync(fd, Buffer.alloc(8, 0xff), 0, 8, (rootpage - 1) * pageSize);
    closeSync(fd);

    const r = await createPlaylist(dbPath, "lib-uuid", { title: "AfterCorruption", trackIds: [1] }, { backupDir });
    expect(isEngineError(r)).toBe(true);
    expect((r as any).detail).toBe("committed_unverified");
    expect(typeof (r as any).backup_path).toBe("string");

    // The write itself went through: quick_check runs after COMMIT, so this
    // error reports a fait accompli, not something that was undone.
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const created = db.prepare("SELECT id FROM Playlist WHERE title = ?").get("AfterCorruption");
    db.close();
    expect(created).toBeTruthy();

    // backup_path is only useful to a DJ if it actually opens and reads.
    const copy = new DatabaseSync((r as any).backup_path, { readOnly: true });
    const existing = copy.prepare("SELECT COUNT(*) c FROM Playlist WHERE title = 'Existing'").get() as any;
    copy.close();
    expect(existing.c).toBe(1);
  });

  it("succeeds on a library that already holds an orphaned playlist entry", async () => {
    // Entries left behind by a deleted playlist are pre-existing damage, and
    // `PRAGMA foreign_key_check(PlaylistEntity)` reports them from inside any
    // transaction -- so scoping the gate to the table meant every
    // create_playlist call on such a library failed forever with "would have
    // broken a foreign key", accusing this write of damage that predates it.
    const { dbPath, backupDir } = setup();
    const seed = new DatabaseSync(dbPath, { enableForeignKeyConstraints: false });
    seed
      .prepare(
        "INSERT INTO PlaylistEntity (listId, trackId, databaseUuid, nextEntityId, membershipReference) VALUES (4242, 7, 'gone-lib', 0, 0)",
      )
      .run();
    seed.close();

    const r = await createPlaylist(dbPath, "lib-uuid", { title: "Despite", trackIds: [1, 2] }, { backupDir });
    expect(isEngineError(r)).toBe(false);
    expect((r as any).tracks_added).toBe(2);
    expect(chain(dbPath, (r as any).playlist_id).map((e) => e.trackId)).toEqual([1, 2]);

    // The orphan is still exactly where it was: this write neither repaired
    // nor removed anyone else's debris.
    const db = new DatabaseSync(dbPath, { readOnly: true });
    expect((db.prepare("SELECT COUNT(*) c FROM PlaylistEntity WHERE listId=4242").get() as any).c).toBe(1);
    db.close();
  });

  it("catches an entry chain that did not read back as written, before COMMIT", async () => {
    // Spec §6.3's second gate, and the only one that can catch a mis-ordered
    // chain: nothing else here compares the links against the order asked
    // for. The mis-ordering is injected by swapping the two arguments of the
    // linking UPDATE, which is exactly the shape of the bug the gate exists
    // for -- a chain written backwards, which every count-based assertion
    // still calls success.
    const { dbPath, backupDir } = setup();
    const realPrepare = DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql: string) {
      const stmt = realPrepare.call(this, sql);
      if (!/UPDATE PlaylistEntity SET nextEntityId/i.test(sql)) return stmt;
      return { run: (next: number, id: number) => stmt.run(id, next) } as any;
    } as typeof realPrepare;
    let r: any;
    try {
      r = await createPlaylist(dbPath, "lib-uuid", { title: "Backwards", trackIds: [3, 4, 5] }, { backupDir });
    } finally {
      DatabaseSync.prototype.prepare = realPrepare;
    }

    expect(isEngineError(r)).toBe(true);
    expect(r.message).toMatch(/did not read back as written/);
    expect(r.detail).toBe("not_committed");
    // Rolled back, so the damaged chain never reached the file.
    const db = new DatabaseSync(dbPath, { readOnly: true });
    expect((db.prepare("SELECT COUNT(*) c FROM Playlist WHERE title='Backwards'").get() as any).c).toBe(0);
    expect((db.prepare("SELECT COUNT(*) c FROM PlaylistEntity").get() as any).c).toBe(2);
    db.close();
  });

  it("refuses a library with a hot journal, without touching it", async () => {
    // Spec §6.2 lists this as a mandatory refusal reason. Left to SQLite, the
    // read-only pre-check throws "attempt to write a readonly database"
    // (rolling a journal forward is a write), which maps to
    // library_unreadable -- the wrong code, and false: the library writes
    // perfectly well once Engine DJ has recovered it. acquire() does not
    // cover it either, since ensureFresh reads the header change counter as
    // raw bytes and never opens the database.
    const { dbPath, backupDir } = setup({ tracks: 3000 });
    await new Promise<void>((resolve, reject) => {
      const child = fork(hotWriterScript, [dbPath]);
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("hot-journal-writer never signalled ready"));
      }, 15_000);
      child.on("message", () => {
        clearTimeout(timer);
        child.kill("SIGKILL");
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("exit", () => resolve());
    });
    expect(existsSync(`${dbPath}-journal`)).toBe(true);

    const r = await createPlaylist(dbPath, "lib-uuid", { title: "Hot", trackIds: [1] }, { backupDir });
    expect(isEngineError(r)).toBe(true);
    expect((r as any).error).toBe("library_needs_recovery");
    expect((r as any).detail).toBe("not_committed");
    expect((r as any).message).toMatch(/launch engine dj/i);
    // Refused before anything was opened or copied.
    expect(existsSync(backupDir)).toBe(false);
  });

});

describe("walkFrom / sameOrder", () => {
  // The in-transaction readback gate is these two functions. They are tested
  // directly as well as through createPlaylist above, because their whole
  // point is what they do to a chain that is *not* the one the writer meant
  // to write, and a passing write never produces one.
  function entriesDb(entries: { id: number; trackId: number; next: number }[]): DatabaseSync {
    const dir = mkdtempSync(join(tmpdir(), "walk-"));
    tempDirs.push(dir);
    const dbPath = makeLibrary(dir, { tracks: 6, uuid: "lib-uuid" });
    addPlaylists(dbPath, [{ id: 1, title: "Chain", nextListId: 0, entries }]);
    return new DatabaseSync(dbPath, { readOnly: true });
  }

  it("reads a correct chain back in link order, not id order", () => {
    // Ids ascending, links descending: an implementation that sorted by id
    // would answer 1,2,3 where the chain says 3,2,1.
    const db = entriesDb([
      { id: 1, trackId: 5, next: 0 },
      { id: 2, trackId: 6, next: 1 },
      { id: 3, trackId: 4, next: 2 },
    ]);
    expect(walkFrom(db, 1, 3).map((r) => r.trackId)).toEqual([4, 6, 5]);
    db.close();
  });

  it("reaches only what the links reach when the chain runs the other way", () => {
    const db = entriesDb([
      { id: 1, trackId: 1, next: 0 },
      { id: 2, trackId: 2, next: 1 },
      { id: 3, trackId: 3, next: 2 },
    ]);
    // Told the head is 1 (as createPlaylist is, by its first insert), a
    // reversed chain yields one entry, not three -- which is what makes
    // sameOrder reject it.
    const walked = walkFrom(db, 1, 1);
    expect(walked.map((r) => r.trackId)).toEqual([1]);
    expect(sameOrder(walked, [
      { uuid: "lib-uuid", trackId: 1 },
      { uuid: "lib-uuid", trackId: 2 },
      { uuid: "lib-uuid", trackId: 3 },
    ])).toBe(false);
    db.close();
  });

  it("stops on a cycle instead of walking forever", () => {
    const db = entriesDb([
      { id: 1, trackId: 1, next: 2 },
      { id: 2, trackId: 2, next: 1 },
    ]);
    expect(walkFrom(db, 1, 1).map((r) => r.trackId)).toEqual([1, 2]);
    db.close();
  });

  it("sameOrder compares the origin pair, not just the length", () => {
    const a = [
      { uuid: "lib-uuid", trackId: 1 },
      { uuid: "other-lib", trackId: 2 },
    ];
    expect(sameOrder(a, [...a])).toBe(true);
    expect(sameOrder(a, [a[1]!, a[0]!])).toBe(false);
    expect(sameOrder(a, [{ uuid: "lib-uuid", trackId: 1 }, { uuid: "lib-uuid", trackId: 2 }])).toBe(false);
    expect(sameOrder(a, a.slice(0, 1))).toBe(false);
  });
});
