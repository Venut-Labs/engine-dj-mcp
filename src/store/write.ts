// src/store/write.ts
//
// The only code in this project that writes to a user's Engine library, and
// it runs only when the server was started with --allow-writes.
//
// The read path is deliberately not reused. Queries run in a forked child
// whose connection is opened readOnly: true, and that guarantee is the
// product's core promise -- teaching it to write would dissolve it for reads
// as well. Writes therefore get their own short-lived connection here:
// validate read-only, snapshot, open, take the write lock, one transaction,
// verify, commit, check, close.
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { err, isEngineError, libraryNeedsRecovery, type EngineError } from "../errors.js";
import { snapshotLibrary } from "./backup.js";
import { hasHotJournal } from "./connections.js";

export interface CreatePlaylistResult {
  playlist_id: number;
  title: string;
  tracks_added: number;
  backup_path: string;
}

/**
 * What editing an existing playlist's entries returns. One shape for
 * add/remove/reorder alike -- each op leaves the fields it did not touch
 * undefined rather than the module growing a result type per verb.
 */
export interface EditResult {
  playlist_id: number;
  tracks_added?: number;
  tracks_removed?: number;
  positions?: number[];
  removed?: { position: number; track_id: number | null }[];
  undo: UndoStep[];
  backup_path: string;
}

/** One step of the tool call that would undo an edit, in the shape a client replays it. */
export interface UndoStep {
  tool: string;
  arguments: Record<string, unknown>;
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
 * Called before the write connection is even opened (see createPlaylist),
 * so it never holds SQLite's RESERVED lock and never blocks a write Engine
 * DJ or a second concurrent call in this process is trying to make at the
 * same moment. The hot-journal check and the read-only pre-check have
 * already run by the time this is called, so a library needing recovery or
 * failing the title/track validation never spends a snapshot slot; a
 * library that turns out to be busy still does, once, and the memo above is
 * what keeps a session that only ever hits library_busy at exactly one
 * snapshot rather than one per retry.
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

/**
 * One playlist's `PlaylistEntity` rows, in the shape `checkChain` wants: an
 * entry id and the id it links to (0 for "links to nothing").
 *
 * Shared by every op that edits an *existing* playlist's entries --
 * createPlaylist never calls this, because it builds a chain from nothing
 * rather than reading one back.
 */
export function readChain(db: DatabaseSync, listId: number): { id: number; next: number }[] {
  return db
    .prepare("SELECT id, nextEntityId AS next FROM PlaylistEntity WHERE listId = ?")
    .all(listId) as { id: number; next: number }[];
}

export interface ChainCheck {
  ok: boolean;
  reason?: string;
  /** Entry ids head to tail. Meaningful only when `ok`. */
  order: number[];
}

/**
 * Whether one playlist's entry chain is sound enough to edit.
 *
 * Deliberately not `orderByChain` from src/playlists.ts. That function's
 * contract is that it returns every node it was given, degrading a damaged
 * chain to a warning, because a reader that silently returned 30 of 43
 * entries would be worse than one that guesses an order and says so. An edit
 * needs the opposite: a yes or no.
 *
 * Four conditions, and each is needed because different breakages trip
 * different ones. Checking only that the walk covered every row is the trap:
 * a list severed into two runs has two heads, and walking from both covers
 * everything -- measured, on a chain broken on purpose, as "5 of 5" while the
 * walk from the real head reached 2. Checking coverage without also checking
 * that the walk *ended* is a second, subtler version of the same trap: a row
 * whose next points back into an already-linked interior row (two
 * predecessors, no row pointing at 0) can visit every row and still never
 * terminate -- the walk stops only because it revisits a row it has already
 * seen, not because it reached the end.
 */
export function checkChain(rows: { id: number; next: number }[]): ChainCheck {
  if (rows.length === 0) return { ok: true, order: [] };
  const byId = new Map(rows.map((r) => [r.id, r]));

  for (const r of rows) {
    if (r.next !== 0 && !byId.has(r.next)) {
      return { ok: false, reason: `entry ${r.id} links to ${r.next}, which is not in this playlist`, order: [] };
    }
  }

  // A self-link (next === id) still counts as something pointing at that row
  // -- unlike orderByChain, which excludes it so the row remains visible as
  // its own one-node run. Here that would instead make the row look like a
  // *second* head next to the real one, turning a one-row cycle in the
  // middle of an otherwise sound chain into a false "two heads" instead of
  // the coverage miss it actually is.
  const targets = new Set(rows.map((r) => r.next));
  const heads = rows.filter((r) => !targets.has(r.id));
  if (heads.length !== 1) {
    return {
      ok: false,
      reason: `expected exactly one head (an entry nothing points at); found ${heads.length}`,
      order: [],
    };
  }

  const order: number[] = [];
  const seen = new Set<number>();
  let cur: { id: number; next: number } | undefined = heads[0];
  // Whether the walk stopped by reaching a row whose next is 0, as opposed
  // to stopping because it looped back onto a row already visited. Coverage
  // alone cannot tell these apart: a converging chain (row 3 pointing back
  // into row 2, an already-visited interior row) walks every row before it
  // repeats one, so `order.length === rows.length` is true for it too. This
  // flag is what distinguishes ending from merely running out of new rows to
  // visit.
  let clean = false;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    order.push(cur.id);
    if (cur.next === 0) {
      clean = true;
      cur = undefined;
    } else {
      cur = byId.get(cur.next);
    }
  }
  // Checked before coverage, and independently of it: a converging chain can
  // cover every row while still having no tail, so coverage passing must not
  // stand in for this.
  if (!clean) {
    return {
      ok: false,
      reason: "the chain does not end -- it loops back into an entry already visited instead of reaching a terminating entry",
      order: [],
    };
  }
  if (order.length !== rows.length) {
    return {
      ok: false,
      reason: `the chain reaches ${order.length} of ${rows.length} entries`,
      order: [],
    };
  }
  return { ok: true, order };
}

/**
 * `checkChain(readChain(db, listId))` in one call. Every point in an edit
 * that needs to know whether a playlist's entry chain is currently sound --
 * the pre-check, the transaction right after BEGIN IMMEDIATE, and the
 * post-write readback -- asks the same question of the same two functions,
 * so it asks it through the same name.
 */
function gateChain(db: DatabaseSync, listId: number): ChainCheck {
  return checkChain(readChain(db, listId));
}

/**
 * Roll back, swallowing a failure of the rollback itself.
 *
 * Every caller is already returning a specific error -- the chain did not read
 * back, the library is busy -- and a ROLLBACK that throws on the way out would
 * replace that reason with its own, telling the user about a failed rollback
 * instead of what actually went wrong. Nothing is lost by ignoring it:
 * db.close() in the finally block ends any transaction still open, and SQLite
 * discards an uncommitted one on close.
 */
function rollback(db: DatabaseSync): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    /* no transaction in progress, or the connection is already gone */
  }
}

export function sameOrder(a: OriginRef[], b: OriginRef[]): boolean {
  return a.length === b.length && a.every((x, i) => x.uuid === b[i]!.uuid && x.trackId === b[i]!.trackId);
}

/**
 * Turns whatever node:sqlite throws into an EngineError. Shared by every op
 * in this module -- the read-only pre-check and the write transaction below
 * it both open a connection to the same file and can hit the same failure
 * modes (the library gone missing mid-session, Engine holding the lock, a
 * foreign or corrupt schema), and a caller whose promise is typed
 * `Promise<... | EngineError>` must never see one of them escape as a
 * rejection instead.
 *
 * `subject` is whatever this write is named for in its own messages -- a new
 * playlist's title for createPlaylist, `playlist ${listId}` for an op that
 * edits one that already exists.
 *
 * Every path that reaches this function is one where the library is
 * unchanged: the transaction either never opened or is rolled back by the
 * caller, and a failure at or after COMMIT is answered before this is ever
 * called (see classifyWriteFailure, below). That is what lets the fallback
 * below say "nothing was changed" without qualification -- it used to say
 * `Writing "X" failed`, which reads as a half-write even when the failure was
 * "file is not a database" and not one byte was attempted.
 */
function mapWriteError(e: unknown, subject: string, mdbPath: string): EngineError {
  const msg = (e as Error).message ?? String(e);
  const isUniqueViolation = /UNIQUE constraint failed/i.test(msg);
  // The constraint's *name* never appears in the message SQLite raises --
  // only the column list does, e.g. "Playlist.title, Playlist.parentListId"
  // -- so the two conditions are checked independently rather than as one
  // pattern that happens to work only because title leads that index today.
  if (isUniqueViolation && /\bPlaylist\.title\b/.test(msg)) {
    return err("playlist_exists", `A playlist called "${subject}" already exists in this library.`, {
      detail: NOT_COMMITTED,
    });
  }
  if (isUniqueViolation && /\bPlaylistEntity\./.test(msg)) {
    return err(
      "duplicate_track",
      `A track in "${subject}" collided with an existing playlist entry; Engine allows a track in a playlist only once.`,
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
  return err("library_unreadable", `Could not write "${subject}": ${msg}. Nothing was changed.`, {
    detail: NOT_COMMITTED,
  });
}

/**
 * "not yet" until COMMIT is reached; "maybe" for the moment COMMIT is in
 * flight; "yes" once it returned. Anything thrown while this is not "not
 * yet" may have left the write on disk -- COMMIT can fail at fsync with
 * SQLITE_IOERR or SQLITE_FULL after the pages are already there, and the
 * post-commit check that follows runs against a database that has
 * definitely changed. Reporting those as not_committed inverts the one
 * discriminator a client uses to decide whether their library still is what
 * it was, and drops the snapshot path in exactly the case where it is the
 * only way back. See classifyWriteFailure, below, which is what reads this.
 */
type CommitState = "not yet" | "maybe" | "yes";

/**
 * The check every write op in this module runs immediately after its own
 * COMMIT, and the COMMITTED_UNVERIFIED error it produces when the database
 * does not come back "ok". Shared because this step is identical for every
 * op here -- only what ran before COMMIT differs.
 *
 * quick_check, not integrity_check: both walk every page -- the difference
 * is that integrity_check additionally cross-checks every index against its
 * table's actual content, and that cross-check is what dominates the cost on
 * a library with hundreds of thousands of tracks. quick_check skips only
 * that verification and still catches the on-disk structural damage (a
 * malformed b-tree page, say) that a check running right after a write
 * exists to catch.
 *
 * check?.quick_check, not check.quick_check: the pragma is documented to
 * return at least one row, but a `.get()` that came back undefined here
 * would raise a TypeError *after* a successful commit, and that lands in
 * whatever catch block called this as an error about a library that has in
 * fact already changed. Reading it as "not ok" says the same true thing
 * without depending on the throw being classified correctly.
 */
function verifyAfterCommit(db: DatabaseSync, subject: string, backupPath: string): EngineError | undefined {
  const check = db.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
  if (check?.quick_check === "ok") return undefined;
  return err(
    "library_unreadable",
    `The database reports "${check?.quick_check ?? "no result"}" after writing "${subject}". A snapshot from before this session's first write is at ${backupPath}.`,
    { detail: COMMITTED_UNVERIFIED, backup_path: backupPath },
  );
}

/**
 * Classifies whatever the write transaction threw, using how far `commit`
 * had gotten when it did. Shared across every op in this module: the
 * three-way split below -- never reached COMMIT, SQLITE_BUSY on COMMIT
 * itself, or past the point of no return -- does not depend on what the
 * transaction was doing before it threw.
 *
 * A COMMIT that returned SQLITE_BUSY is the one in-flight failure SQLite
 * defines precisely: the transaction stays open and nothing was written, so
 * it is a plain retry, not an unverified write. Everything else that throws
 * once COMMIT has started is past the point of no return: no ROLLBACK,
 * because after a successful COMMIT there is no transaction left to roll
 * back, and after a COMMIT that failed mid-flight there is no state this
 * code can reason about well enough to undo by hand (the caller's `finally`
 * block's db.close() ends anything still open). The honest answer there is
 * that the write may have gone through, plus the path of the snapshot from
 * before this session's first write, which is the only case where restoring
 * one is ever the right next step.
 */
function classifyWriteFailure(
  e: unknown,
  commit: CommitState,
  subject: string,
  mdbPath: string,
  backupPath: string,
  db: DatabaseSync | undefined,
  open: boolean,
): EngineError {
  const busyOnCommit = commit === "maybe" && /SQLITE_BUSY|database is locked/i.test((e as Error)?.message ?? "");
  if (commit === "not yet" || busyOnCommit) {
    if (open && db) rollback(db);
    return mapWriteError(e, subject, mdbPath);
  }
  const msg = (e as Error)?.message ?? String(e);
  return err(
    "library_unreadable",
    `Writing "${subject}" may have gone through: the library could not be verified afterwards (${msg}). ` +
      `Check the library in Engine DJ. A snapshot from before this session's first write is at ${backupPath}.`,
    { detail: COMMITTED_UNVERIFIED, backup_path: backupPath },
  );
}

/**
 * Owns everything past the read-only pre-check that every write op in this
 * module does identically: snapshot, open, `PRAGMA foreign_keys = ON`,
 * `BEGIN IMMEDIATE`, commit, verify, and classify whatever went wrong.
 * `body` does the one thing that differs between ops -- the INSERTs and
 * UPDATEs specific to what this write is -- against the open `db` it is
 * handed, and returns either the result to hand back (minus `backup_path`,
 * which this function fills in once it knows COMMIT succeeded) or an
 * `EngineError` it has *already rolled back* before returning, exactly as
 * a `catch` block here would.
 *
 * `isEngineError`, not a second return channel, is what tells `body`'s
 * success value apart from its failure one: this module already exports
 * that check for callers, so reusing it here means a body never has to wrap
 * its result to disambiguate the two.
 */
async function withWriteTransaction<T extends object>(
  mdbPath: string,
  uuid: string,
  subject: string,
  opts: { backupDir: string },
  body: (db: DatabaseSync) => T | EngineError,
): Promise<(T & { backup_path: string }) | EngineError> {
  // Snapshot here, before the write connection is even opened, not after
  // BEGIN IMMEDIATE. Taking it with RESERVED held meant a full-database copy
  // -- tens of seconds on a multi-gigabyte USB library -- ran while every
  // write Engine DJ attempted failed with SQLITE_BUSY, and a second
  // concurrent call in this process (the MCP SDK dispatches concurrently)
  // was told the library was locked by Engine DJ when it was this server
  // holding the lock. Snapshotting before BEGIN IMMEDIATE used to mean a
  // call that turned out to be busy spent a slot on every retry -- ten busy
  // retries, ten full copies, evicting every genuine pre-write snapshot from
  // backup.ts's KEEP window. The per-session memo (sessionSnapshot, above)
  // is what makes moving it here safe: a session that only ever gets
  // library_busy now leaves exactly one snapshot, not one per retry, so
  // nothing is evicted. The hot-journal check and the read-only pre-check
  // that ran before this was ever called still run first, so a call doomed
  // by either of those still never copies anything.
  const snapshot = await sessionSnapshot(mdbPath, uuid, opts.backupDir);
  // snapshotLibrary sets no detail of its own (src/store/backup.ts); this is
  // still a pre-commit failure, so the discriminator applies here too.
  if (typeof snapshot !== "string") return { ...snapshot, detail: NOT_COMMITTED };
  const backupPath = snapshot;

  let db: DatabaseSync | undefined;
  let open = false;
  let commit: CommitState = "not yet";
  try {
    db = new DatabaseSync(mdbPath);
    open = true;
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("BEGIN IMMEDIATE");

    const result = body(db);
    if (isEngineError(result)) return result;

    commit = "maybe";
    db.exec("COMMIT");
    commit = "yes";

    const verifyErr = verifyAfterCommit(db, subject, backupPath);
    if (verifyErr) return verifyErr;

    return { ...result, backup_path: backupPath };
  } catch (e) {
    return classifyWriteFailure(e, commit, subject, mdbPath, backupPath, db, open);
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed */
    }
  }
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
  const trackRefs = refs;

  return withWriteTransaction(mdbPath, uuid, title, opts, (db) => {
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
    for (const ref of trackRefs) {
      ids.push(Number(insEntity.run(listId, ref.trackId, ref.uuid).lastInsertRowid));
    }
    for (let i = 0; i + 1 < ids.length; i++) link.run(ids[i + 1], ids[i]);

    // No foreign-key gate here, though spec §6.3 asks for one. PlaylistEntity
    // carries exactly one foreign key -- listId -> Playlist(id) -- it is not
    // DEFERRABLE, and this connection sets PRAGMA foreign_keys = ON, so a bad
    // listId is refused by SQLite at the INSERT above and never reaches a
    // check. The listId asked about would in any case be the one this
    // transaction just inserted, which exists by construction. A gate whose
    // condition cannot become true is not a safety net; it reads as one,
    // which is worse than its absence. (`PRAGMA foreign_key_check(...)` is
    // not the alternative: it reports every orphan in the table, so a
    // PlaylistEntity row left behind by some earlier deleted playlist would
    // fail every create_playlist call on that library forever, blaming this
    // write for damage that predates it.)
    if (ids.length > 0 && !sameOrder(walkFrom(db, listId, ids[0]!), trackRefs)) {
      rollback(db);
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

    return { playlist_id: listId, title, tracks_added: trackRefs.length };
  });
}

/** Where `addTracksToPlaylist`'s `at` can put the new run. */
export type InsertAt = "end" | "start" | { after_position: number };

/**
 * Resolves `at` against a chain's *current* order into a 0-based insert
 * index, or `invalid_position` if `after_position` names a position that
 * order does not have.
 *
 * Called twice by addTracksToPlaylist, against two different reads of the
 * same chain, deliberately: once in the pre-check, to fail fast, and again
 * inside the transaction against the chain BEGIN IMMEDIATE just locked. The
 * second call is the one that matters -- the pre-check's `order` can be
 * stale by the time the lock is held, and reusing its answer instead of
 * recomputing this one would mean a playlist that shrank in between turns a
 * clean invalid_position refusal into `gate.order[insertAt - 1]` reading
 * past the end of the array.
 */
function resolveInsertAt(order: number[], at: InsertAt, listId: number): number | EngineError {
  if (at === "start") return 0;
  if (at === "end") return order.length;
  const p = at.after_position;
  if (!Number.isInteger(p) || p < 1 || p > order.length) {
    return err(
      "invalid_position",
      `Playlist ${listId} has ${order.length} entries; after_position must be between 1 and ${order.length}.`,
      { detail: NOT_COMMITTED },
    );
  }
  return p;
}

/**
 * Adds one or more tracks to an existing playlist, at the start, the end, or
 * after a named position in its current order.
 *
 * Shares its skeleton with createPlaylist: a read-only pre-check first (cheap
 * enough to rule out the common failure modes without ever opening the
 * library for writing), then withWriteTransaction. Where createPlaylist
 * builds a chain from nothing, this extends one that already exists, so it
 * also has to confirm that chain is sound before it touches it -- twice. The
 * pre-check gates it once, both to fail fast (and skip the snapshot) for a
 * playlist that cannot be edited at all, and because validating `at` needs
 * to know how many entries the playlist currently has. The transaction gates
 * it again after BEGIN IMMEDIATE, because that lock is the first moment
 * nothing else can change the chain -- gating on the pre-check's read alone,
 * or reusing the insert position it computed, would be trusting one that
 * could already be stale.
 */
export async function addTracksToPlaylist(
  mdbPath: string,
  uuid: string,
  input: { listId: number; trackIds: number[]; at: InsertAt },
  opts: { backupDir: string },
): Promise<EditResult | EngineError> {
  const { listId, trackIds, at } = input;
  // Not a playlist title -- there isn't one here -- but the same role: what
  // this write is named for in mapWriteError/verifyAfterCommit/
  // classifyWriteFailure's shared messages.
  const subject = `playlist ${listId}`;

  if (trackIds.length === 0) {
    return err("invalid_argument", "Name at least one track to add.", { detail: NOT_COMMITTED });
  }

  // See createPlaylist for why this has to be checked before anything else
  // even tries to open the file.
  if (hasHotJournal(mdbPath)) return { ...libraryNeedsRecovery(), detail: NOT_COMMITTED };

  let refs: OriginRef[] | EngineError;
  {
    let precheck: DatabaseSync | undefined;
    try {
      precheck = new DatabaseSync(mdbPath, { readOnly: true });

      const exists = precheck.prepare("SELECT 1 FROM Playlist WHERE id = ?").get(listId);
      if (!exists) {
        return err("playlist_not_found", `No playlist with id ${listId} in this library.`, {
          detail: NOT_COMMITTED,
        });
      }

      const gate = gateChain(precheck, listId);
      if (!gate.ok) {
        return err("playlist_chain_damaged", `Playlist ${listId}: ${gate.reason}. Nothing was changed.`, {
          detail: NOT_COMMITTED,
        });
      }

      refs = resolveOrigins(precheck, trackIds);
      if (!Array.isArray(refs)) return refs;

      // UNIQUE (listId, databaseUuid, trackId) protects a pair, not a
      // track, and this check is not stronger than that constraint: it
      // resolves every existing entry back to a local track and compares
      // against the request, which is exactly the constraint's own check,
      // just run early. Its value is failing fast -- before the snapshot is
      // copied and before a write transaction opens, with a message naming
      // the track, rather than a UNIQUE-constraint violation surfacing from
      // inside a transaction and getting mapped back to the same code.
      //
      // It cannot catch more than the constraint can. An entry whose stored
      // (databaseUuid, trackId) no longer resolves to any local track --
      // which is what a library looks like right after a re-origination
      // moves a track's origin on without updating the entries that named
      // its old one -- is not a case this check (or the constraint) can
      // call a duplicate: nothing in the database still says that entry and
      // the requested track are the same one. That is a property of the
      // data, not a gap in the check.
      const existing = precheck
        .prepare("SELECT trackId, databaseUuid FROM PlaylistEntity WHERE listId = ?")
        .all(listId) as { trackId: number; databaseUuid: string }[];
      const resolveLocal = precheck.prepare(
        "SELECT id FROM Track WHERE originDatabaseUuid = ? AND originTrackId = ?",
      );
      const requested = new Set(trackIds);
      for (const e of existing) {
        const local = resolveLocal.get(e.databaseUuid, e.trackId) as { id: number } | undefined;
        if (local && requested.has(local.id)) {
          return err(
            "duplicate_track",
            `Track ${local.id} is already in playlist ${listId}; Engine allows a track in a playlist only once.`,
            { detail: NOT_COMMITTED },
          );
        }
      }

      // Discarded once it has done its job: only the pass/fail matters here
      // (see resolveInsertAt's own comment for why the number itself is not
      // carried across the lock).
      const insertAt = resolveInsertAt(gate.order, at, listId);
      if (isEngineError(insertAt)) return insertAt;
    } catch (e) {
      return mapWriteError(e, subject, mdbPath);
    } finally {
      try {
        precheck?.close();
      } catch {
        /* never opened, or already closed */
      }
    }
  }
  const trackRefs = refs;

  return withWriteTransaction(mdbPath, uuid, subject, opts, (db) => {
    // The chain read in the pre-check is re-read here: BEGIN IMMEDIATE is
    // the first moment nothing else can change it, and gating on a chain
    // read before the lock would be gating on a stale one.
    const gate = gateChain(db, listId);
    if (!gate.ok) {
      rollback(db);
      return err("playlist_chain_damaged", `Playlist ${listId}: ${gate.reason}. Nothing was changed.`, {
        detail: NOT_COMMITTED,
      });
    }

    // Re-resolved against this read of the chain, not the pre-check's: see
    // resolveInsertAt's comment.
    const insertAt = resolveInsertAt(gate.order, at, listId);
    if (isEngineError(insertAt)) {
      rollback(db);
      return insertAt;
    }

    // What the final chain should read back as: the existing entries' track
    // identities, with the requested tracks spliced in at the position this
    // call resolved to. Built before the writes below, from a walk keyed by
    // id rather than by row count, so the readback check afterwards does not
    // itself depend on how the writes below number their new rows.
    const existingRefs = gate.order.length > 0 ? walkFrom(db, listId, gate.order[0]!) : [];
    const expected = [...existingRefs.slice(0, insertAt), ...trackRefs, ...existingRefs.slice(insertAt)];

    // Insert one row at a time, linking by the id each insert actually
    // returned -- the same reason createPlaylist does: SQLite assigning
    // AUTOINCREMENT in ORDER BY order is optimizer behaviour, not a promise.
    const insEntity = db.prepare(
      `INSERT INTO PlaylistEntity (listId, trackId, databaseUuid, nextEntityId, membershipReference)
       VALUES (?, ?, ?, 0, 0)`,
    );
    const link = db.prepare("UPDATE PlaylistEntity SET nextEntityId = ? WHERE id = ?");
    const ids: number[] = trackRefs.map((ref) => Number(insEntity.run(listId, ref.trackId, ref.uuid).lastInsertRowid));
    for (let i = 0; i + 1 < ids.length; i++) link.run(ids[i + 1]!, ids[i]!);

    if (ids.length > 0) {
      if (insertAt === 0) {
        // Inserting at the start needs no other row touched, because nothing
        // links to a head: the new run just becomes the head, ending in
        // whatever was the old one (0 if the playlist was empty).
        const oldHead = gate.order.length > 0 ? gate.order[0]! : 0;
        link.run(oldHead, ids[ids.length - 1]!);
      } else {
        // Otherwise the new run is spliced in after gate.order[insertAt - 1]:
        // its link is repointed at the first new row, and the last new row
        // takes the link the predecessor had (0 if it was the tail).
        const predId = gate.order[insertAt - 1]!;
        const predNext = insertAt < gate.order.length ? gate.order[insertAt]! : 0;
        link.run(ids[0]!, predId);
        link.run(predNext, ids[ids.length - 1]!);
      }
    }

    // Re-gated, not just re-walked: sameOrder alone confirms the *values*
    // survived the round trip in order, but a wrong implementation could in
    // principle produce a chain that still walks to the right values from
    // this head (e.g. a converging link elsewhere) while failing checkChain.
    // Both are cheap; there is no reason to trust only one of them here.
    const newHeadId = insertAt === 0 ? (ids[0] ?? gate.order[0] ?? 0) : gate.order[0]!;
    const finalGate = gateChain(db, listId);
    if (!finalGate.ok || !sameOrder(walkFrom(db, listId, newHeadId), expected)) {
      rollback(db);
      return err(
        "library_unreadable",
        `The entry chain for playlist ${listId} did not read back as written; nothing was changed.`,
        { detail: NOT_COMMITTED },
      );
    }

    // No trigger maintains this: measured, changing PlaylistEntity leaves the
    // parent Playlist row untouched. datetime('now'), not strftime('%s') --
    // that is the Track convention, and Playlist.lastEditTime is TEXT.
    db.prepare("UPDATE Playlist SET lastEditTime = datetime('now') WHERE id = ?").run(listId);

    const positions = ids.map((_, i) => insertAt + 1 + i);
    return {
      playlist_id: listId,
      tracks_added: trackRefs.length,
      positions,
      undo: [{ tool: "remove_tracks_from_playlist", arguments: { playlist_id: listId, positions } }],
    };
  });
}
