// src/store/write.ts
//
// The only code in this project that writes to a user's Engine library, and
// it runs only when the server was started with --allow-writes.
//
// The read path is deliberately not reused. Queries run in a forked child
// whose connection is opened readOnly: true, and that guarantee is the
// product's core promise -- teaching it to write would dissolve it for reads
// as well. Writes therefore get their own short-lived connection here:
// validate read-only, open, take the write lock, snapshot, one transaction,
// verify, commit, check, close.
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { err, libraryNeedsRecovery, type EngineError } from "../errors.js";
import { snapshotLibrary } from "./backup.js";
import { hasHotJournal } from "./connections.js";

export interface CreatePlaylistResult {
  playlist_id: number;
  title: string;
  tracks_added: number;
  backup_path: string;
}

export interface OriginRef {
  uuid: string;
  trackId: number;
}

/**
 * `detail` discriminator values for the EngineError this module returns.
 * Stable across releases so a caller can decide "is the library still what
 * it was" without parsing message prose. Everything before COMMIT --
 * including validation that never reaches the database at all -- collapses
 * to the same NOT_COMMITTED answer. COMMITTED_UNVERIFIED is produced by
 * exactly two things, and both mean "the playlist may be on disk": the
 * post-commit check reporting anything but "ok", and anything thrown from
 * the COMMIT itself onwards. It is also the only case that carries
 * backup_path, because it is the only case where restoring from a snapshot
 * is ever the right next step.
 *
 * These two strings are part of the tool's contract; see src/errors.ts.
 */
const NOT_COMMITTED = "not_committed";
const COMMITTED_UNVERIFIED = "committed_unverified";

/**
 * One snapshot per library per process, which is what "before the first write
 * of a session" means in the spec (§6.1) and in the README.
 *
 * Keyed by backup directory, library path *and* uuid so a test (or a second
 * configured backup root) cannot silently reuse a snapshot that lives
 * somewhere else -- and so a different library that lands at the same path
 * (a second USB stick sharing a volume label, an m.db replaced in place)
 * cannot hit another library's cached entry and hand back its snapshot as
 * this session's way back. The value is only ever a snapshot that actually
 * landed on disk; a failed snapshot is not cached, so the next write tries
 * again.
 */
const sessionSnapshots = new Map<string, string>();

/** Test seam only: forget this process's snapshots so a test can start clean. */
export function resetSessionSnapshots(): void {
  sessionSnapshots.clear();
}

/**
 * The snapshot for this library, taken once per process.
 *
 * Called with the write transaction already open (see createPlaylist): by
 * that point BEGIN IMMEDIATE has succeeded, so a locked library, a read-only
 * one and a missing one are all already ruled out and none of them can spend
 * a snapshot slot. Reading the file through a second, read-only connection
 * while this process holds RESERVED is safe and yields the *pre-write* state
 * -- verified: a snapshot taken between INSERT and COMMIT contains the rows
 * as they were before BEGIN IMMEDIATE.
 */
async function sessionSnapshot(
  mdbPath: string,
  uuid: string,
  backupDir: string,
): Promise<string | EngineError> {
  const key = `${backupDir}\u0000${mdbPath}\u0000${uuid}`;
  // existsSync, not a bare Map hit: a user who cleared ~/.engine-dj-mcp/backups
  // mid-session must get a real snapshot back, not a path to a deleted file.
  const cached = sessionSnapshots.get(key);
  if (cached && existsSync(cached)) return cached;
  const fresh = await snapshotLibrary(mdbPath, uuid, backupDir);
  if (typeof fresh === "string") sessionSnapshots.set(key, fresh);
  return fresh;
}

/**
 * Engine stores a playlist entry's track as the pair the track was *born*
 * with, not as a local row id. On both libraries measured, originTrackId
 * happens to equal id -- which is exactly why this translation has to be
 * explicit and tested against re-originated rows: the naive version is
 * invisible in normal use and wrong on any library that has travelled.
 */
function resolveOrigins(db: DatabaseSync, trackIds: number[]): OriginRef[] | EngineError {
  const seen = new Set<number>();
  for (const id of trackIds) {
    if (seen.has(id)) {
      return err(
        "duplicate_track",
        `Track ${id} appears more than once; Engine allows a track in a playlist only once.`,
        { detail: NOT_COMMITTED },
      );
    }
    seen.add(id);
  }
  const stmt = db.prepare(
    "SELECT originDatabaseUuid AS uuid, originTrackId AS trackId FROM Track WHERE id = ?",
  );
  const refs: OriginRef[] = [];
  for (const id of trackIds) {
    const row = stmt.get(id) as { uuid: string | null; trackId: number | null } | undefined;
    // == null, not a falsy check: originTrackId = 0 or originDatabaseUuid =
    // "" are real values a track can legitimately carry, not "not found".
    if (!row || row.uuid == null || row.trackId == null) {
      return err("unknown_track", `No track with id ${id} in this library.`, { detail: NOT_COMMITTED });
    }
    refs.push({ uuid: row.uuid, trackId: row.trackId });
  }
  return refs;
}

/**
 * Read the chain back starting from a row we know is the head, because we
 * inserted it first. Re-deriving the head as "the row nothing points at"
 * would be the same assumption the write just made, so it could not catch a
 * write that made it wrongly.
 *
 * This, together with `sameOrder`, confirms that the *links* survived the
 * round trip in the order given -- it does not independently confirm the
 * *values* are correct. The comparison target is `refs`, the same array
 * `resolveOrigins` produced and the write consumed, so a `resolveOrigins`
 * that resolved every id wrongly (e.g. to the local row id instead of the
 * origin pair) would write wrong values, read the same wrong values back,
 * and pass this check. Catching that class of bug is what the
 * re-originated-track test is for, not this readback.
 */
export function walkFrom(db: DatabaseSync, listId: number, headId: number): OriginRef[] {
  const rows = db
    .prepare("SELECT id, trackId, databaseUuid, nextEntityId FROM PlaylistEntity WHERE listId = ?")
    .all(listId) as { id: number; trackId: number; databaseUuid: string; nextEntityId: number }[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: OriginRef[] = [];
  const seen = new Set<number>();
  let cur = byId.get(headId);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.push({ uuid: cur.databaseUuid, trackId: cur.trackId });
    cur = byId.get(cur.nextEntityId);
  }
  return out;
}

export function sameOrder(a: OriginRef[], b: OriginRef[]): boolean {
  return a.length === b.length && a.every((x, i) => x.uuid === b[i]!.uuid && x.trackId === b[i]!.trackId);
}

/**
 * Turns whatever node:sqlite throws into an EngineError. Shared between the
 * read-only pre-check and the write transaction below it: both open a
 * connection to the same file and can hit the same failure modes (the
 * library gone missing mid-session, Engine holding the lock, a foreign or
 * corrupt schema), and a caller whose promise is typed
 * `Promise<CreatePlaylistResult | EngineError>` must never see one of them
 * escape as a rejection instead.
 *
 * Every path that reaches this function is one where the library is
 * unchanged: the transaction either never opened or is rolled back by the
 * caller, and a failure at or after COMMIT is answered before this is ever
 * called (see createPlaylist's catch). That is what lets the fallback below
 * say "nothing was changed" without qualification -- it used to say
 * `Writing "X" failed`, which reads as a half-write even when the failure was
 * "file is not a database" and not one byte was attempted.
 */
function mapWriteError(e: unknown, title: string, mdbPath: string): EngineError {
  const msg = (e as Error).message ?? String(e);
  const isUniqueViolation = /UNIQUE constraint failed/i.test(msg);
  // The constraint's *name* never appears in the message SQLite raises --
  // only the column list does, e.g. "Playlist.title, Playlist.parentListId"
  // -- so the two conditions are checked independently rather than as one
  // pattern that happens to work only because title leads that index today.
  if (isUniqueViolation && /\bPlaylist\.title\b/.test(msg)) {
    return err("playlist_exists", `A playlist called "${title}" already exists in this library.`, {
      detail: NOT_COMMITTED,
    });
  }
  if (isUniqueViolation && /\bPlaylistEntity\./.test(msg)) {
    return err(
      "duplicate_track",
      `A track in "${title}" collided with an existing playlist entry; Engine allows a track in a playlist only once.`,
      { detail: NOT_COMMITTED },
    );
  }
  if (/SQLITE_BUSY|database is locked/i.test(msg)) {
    return err("library_busy", "The library is locked by Engine DJ or a player. Close it and try again.", {
      detail: NOT_COMMITTED,
    });
  }
  if (/readonly|attempt to write a readonly database/i.test(msg)) {
    return err("library_unreadable", `The library at ${mdbPath} cannot be written to.`, { detail: NOT_COMMITTED });
  }
  // The volume can go away between discovery and this call -- a USB drive
  // pulled mid-set is the live-performance version of this. node:sqlite's
  // message for that is generic ("unable to open database file"), so this
  // is matched by wording rather than an errno, the same tradeoff every
  // other branch here makes.
  if (/unable to open database file/i.test(msg)) {
    return err("library_not_found", `No Engine library database at ${mdbPath}.`, { detail: NOT_COMMITTED });
  }
  return err("library_unreadable", `Could not write "${title}": ${msg}. Nothing was changed.`, {
    detail: NOT_COMMITTED,
  });
}

export async function createPlaylist(
  mdbPath: string,
  uuid: string,
  input: { title: string; trackIds: number[] },
  opts: { backupDir: string },
): Promise<CreatePlaylistResult | EngineError> {
  const title = input.title.trim();
  if (!title) return err("invalid_argument", "A playlist needs a non-empty title.", { detail: NOT_COMMITTED });

  // A hot journal is a mandatory refusal reason (spec §6.2), and it has to be
  // checked here rather than left to whatever opens the file first: SQLite
  // refuses to open such a database *read-only* (rolling the journal forward
  // is a write) with the raw "attempt to write a readonly database", which
  // this module would otherwise map to library_unreadable -- the wrong code,
  // and actively false, since the library can be written to perfectly well
  // once Engine DJ has recovered it. Nor does the caller's acquire() cover
  // it: IndexManager.ensureFresh reads the header change counter as raw
  // bytes and returns "fresh" without opening the database at all, so a
  // journal left behind after an earlier successful read reaches this
  // function untouched.
  if (hasHotJournal(mdbPath)) return { ...libraryNeedsRecovery(), detail: NOT_COMMITTED };

  // Validate against a short-lived read-only connection before opening the
  // library for writing at all. This pass only rules out the common case
  // cheaply -- another writer can still create the same title (or, in
  // principle, the same entry) between this check and the INSERT below, so
  // the UNIQUE-constraint catch further down stays in place as the backstop
  // for that race and must still report it correctly, not as a generic
  // failure.
  let refs: OriginRef[] | EngineError;
  {
    // The constructor is inside the try, not just the statements after it:
    // a missing file, an unmounted volume, or Engine holding the lock all
    // fail right here, and this connection must report those exactly like
    // the write connection below does rather than let them throw past
    // createPlaylist's Promise<CreatePlaylistResult | EngineError> contract.
    let precheck: DatabaseSync | undefined;
    try {
      precheck = new DatabaseSync(mdbPath, { readOnly: true });
      const exists = precheck.prepare("SELECT 1 FROM Playlist WHERE title = ? AND parentListId = 0").get(title);
      if (exists) {
        return err("playlist_exists", `A playlist called "${title}" already exists in this library.`, {
          detail: NOT_COMMITTED,
        });
      }
      refs = resolveOrigins(precheck, input.trackIds);
    } catch (e) {
      return mapWriteError(e, title, mdbPath);
    } finally {
      try {
        precheck?.close();
      } catch {
        /* never opened, or already closed */
      }
    }
  }
  if (!Array.isArray(refs)) return refs;

  let db: DatabaseSync | undefined;
  let open = false;
  /**
   * "not yet" until COMMIT is reached; "maybe" for the moment COMMIT is in
   * flight; "yes" once it returned. Anything thrown while this is not "not
   * yet" may have left the playlist on disk -- COMMIT can fail at fsync with
   * SQLITE_IOERR or SQLITE_FULL after the pages are already there, and the
   * post-commit check below runs against a database that has definitely
   * changed. Reporting those as not_committed (which is what a single catch
   * calling mapWriteError did) inverts the one discriminator a client uses to
   * decide whether their library still is what it was, and drops the snapshot
   * path in exactly the case where it is the only way back.
   */
  let commit: "not yet" | "maybe" | "yes" = "not yet";
  let backupPath: string | undefined;
  try {
    db = new DatabaseSync(mdbPath);
    open = true;
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("BEGIN IMMEDIATE");

    // Snapshot here, not before opening: with BEGIN IMMEDIATE held, a locked
    // library (library_busy -- the expected answer while Engine DJ is
    // writing), a read-only one and a missing one have all already been
    // ruled out. Snapshotting first meant ten busy retries took ten full
    // copies of m.db and evicted every genuine pre-write snapshot from
    // backup.ts's KEEP window -- the same eviction problem the title
    // pre-check above exists to prevent, on the more common trigger.
    const snapshot = await sessionSnapshot(mdbPath, uuid, opts.backupDir);
    // snapshotLibrary sets no detail of its own (src/store/backup.ts); this is
    // still a pre-commit failure, so the discriminator applies here too.
    if (typeof snapshot !== "string") {
      db.exec("ROLLBACK");
      return { ...snapshot, detail: NOT_COMMITTED };
    }
    backupPath = snapshot;

    // nextListId = 0 appends: Engine's own insert triggers move the tail
    // marker off the previous last row and point it at this one.
    const ins = db
      .prepare(
        `INSERT INTO Playlist (title, parentListId, isPersisted, nextListId, lastEditTime, isExplicitlyExported)
         VALUES (?, 0, 1, 0, datetime('now'), 0)`,
      )
      .run(title);
    const listId = Number(ins.lastInsertRowid);

    // One row at a time, linked by the id the insert actually returned.
    // A single INSERT ... SELECT ... ORDER BY would depend on SQLite
    // assigning AUTOINCREMENT in sort order, which it does today and does not
    // promise; the failure mode is a playlist with the right tracks in the
    // wrong order, which looks like success.
    const insEntity = db.prepare(
      `INSERT INTO PlaylistEntity (listId, trackId, databaseUuid, nextEntityId, membershipReference)
       VALUES (?, ?, ?, 0, 0)`,
    );
    const link = db.prepare("UPDATE PlaylistEntity SET nextEntityId = ? WHERE id = ?");
    const ids: number[] = [];
    for (const ref of refs) {
      ids.push(Number(insEntity.run(listId, ref.trackId, ref.uuid).lastInsertRowid));
    }
    for (let i = 0; i + 1 < ids.length; i++) link.run(ids[i + 1], ids[i]);

    // Spec §6.3's foreign-key gate, asserted about the rows *this transaction
    // wrote* rather than about the table they went into.
    //
    // PlaylistEntity carries exactly one foreign key -- listId -> Playlist(id)
    // -- so this query is that key, checked on our own rows. `PRAGMA
    // foreign_key_check(PlaylistEntity)` looked equivalent and is not: it
    // reports every orphan in the table, and one PlaylistEntity row left
    // behind by a deleted playlist (measured: a pre-existing orphan comes back
    // from the scoped pragma inside an unrelated transaction) would fail every
    // create_playlist call on that library forever, accusing this write of
    // damage that predates it in words the user cannot tell apart from a real
    // violation. The cross-library debris these libraries do accumulate --
    // entries naming a third library's (databaseUuid, trackId), see
    // src/playlists.ts:52-58 -- is not a foreign key at all and no pragma
    // scoping ever protected against it.
    const orphan = db
      .prepare("SELECT 1 FROM PlaylistEntity WHERE listId = ? AND listId NOT IN (SELECT id FROM Playlist)")
      .get(listId);
    if (orphan) {
      db.exec("ROLLBACK");
      return err("library_unreadable", `Writing "${title}" would have broken a foreign key; nothing was changed.`, {
        detail: NOT_COMMITTED,
      });
    }
    if (ids.length > 0 && !sameOrder(walkFrom(db, listId, ids[0]!), refs)) {
      db.exec("ROLLBACK");
      return err(
        "library_unreadable",
        `The entry chain for "${title}" did not read back as written; nothing was changed.`,
        { detail: NOT_COMMITTED },
      );
    }
    // No check that exactly one Playlist row has nextListId = 0: the schema's
    // own C_NEXT_LIST_ID_UNIQUE_FOR_PARENT constraint already permits at most
    // one per parent, and this insert always uses nextListId = 0, so more
    // than one tail is not a state this transaction can produce. Restating
    // that as a runtime check would be a tautology, not a safety net.

    commit = "maybe";
    db.exec("COMMIT");
    commit = "yes";

    // quick_check, not integrity_check: both walk every page -- the
    // difference is that integrity_check additionally cross-checks every
    // index against its table's actual content, and that cross-check is
    // what dominates the cost on a library with hundreds of thousands of
    // tracks. quick_check skips only that verification and still catches
    // the on-disk structural damage (a malformed b-tree page, say) that a
    // check running right after a write exists to catch.
    //
    // check?.quick_check, not check.quick_check: the pragma is documented to
    // return at least one row, but a `.get()` that came back undefined here
    // would raise a TypeError *after* a successful commit, and that lands in
    // the catch below as an error about a library that has in fact already
    // changed. Reading it as "not ok" says the same true thing without
    // depending on the throw being classified correctly.
    const check = db.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
    if (check?.quick_check !== "ok") {
      return err(
        "library_unreadable",
        `The database reports "${check?.quick_check ?? "no result"}" after writing "${title}". A snapshot from before the write is at ${backupPath}.`,
        { detail: COMMITTED_UNVERIFIED, backup_path: backupPath },
      );
    }

    return { playlist_id: listId, title, tracks_added: refs.length, backup_path: backupPath };
  } catch (e) {
    // A COMMIT that returned SQLITE_BUSY is the one in-flight failure SQLite
    // defines precisely: the transaction stays open and nothing was written,
    // so it is a plain retry, not an unverified write.
    const busyOnCommit = commit === "maybe" && /SQLITE_BUSY|database is locked/i.test((e as Error)?.message ?? "");
    if (commit === "not yet" || busyOnCommit) {
      if (open && db) {
        try {
          db.exec("ROLLBACK");
        } catch {
          /* no transaction in progress */
        }
      }
      return mapWriteError(e, title, mdbPath);
    }
    // Past the point of no return. No ROLLBACK: after a successful COMMIT
    // there is no transaction to roll back, and after a COMMIT that failed
    // mid-flight there is no state we can reason about well enough to undo
    // by hand -- db.close() in the finally block ends anything still open.
    // The honest answer is that the write may have gone through, plus the
    // path of the snapshot from before it, which is the only case where
    // restoring one is ever the right next step.
    const msg = (e as Error)?.message ?? String(e);
    return err(
      "library_unreadable",
      `Writing "${title}" may have gone through: the library could not be verified afterwards (${msg}). ` +
        `Check the library in Engine DJ. A snapshot from before the write is at ${backupPath}.`,
      { detail: COMMITTED_UNVERIFIED, ...(backupPath ? { backup_path: backupPath } : {}) },
    );
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed */
    }
  }
}
