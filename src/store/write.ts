// src/store/write.ts
//
// Writes to a user's Engine library, together with src/store/track-metadata.ts
// (which reuses withWriteTransaction, mapWriteError and rollback from here).
// Both run only when the server was started with --allow-writes.
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
import { redactPath } from "../paths.js";

export interface CreatePlaylistResult {
  playlist_id: number;
  title: string;
  tracks_added: number;
  library: LibraryRef;
  backup_path: string;
}

/**
 * Which library a write actually landed in. Two connected libraries -- a USB
 * drive and its copy on the computer -- is the ordinary setup, so "which one
 * did that go to" is a question every write result has to answer on its own,
 * without the caller re-deriving it from an argument it may not have passed.
 *
 * It is also the context `undo` needs: an undo reverses the edit in this
 * library and cannot reach a copy Engine DJ has since propagated to another
 * one (measured 2026-09-01, see README).
 */
export interface LibraryRef {
  uuid: string;
  /** The m.db path, in the `~/...` form list_libraries prints. */
  path: string;
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
  /**
   * Whether replaying every step of `undo` puts the playlist back exactly as
   * it was. Always present, never inferred from `undo`'s length: a client
   * that read a missing field as false -- or a full-looking `undo` as
   * complete -- would get the one question that matters here backwards.
   *
   * False only for removeTracksFromPlaylist, and only for a removal that
   * included an entry whose stored origin pair matches no track in this
   * library. Such an entry has no track id to hand back to
   * add_tracks_to_playlist, so no undo step for it can exist; `undo_note`
   * then names those positions. The steps that *are* emitted still run, and
   * still restore everything else to its original position.
   */
  undo_complete: boolean;
  /** Set only when `undo_complete` is false: which positions have no way back, and why. */
  undo_note?: string;
  library: LibraryRef;
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
/** Exported for src/store/track-metadata*.ts; the string is part of the tool contract. */
export const NOT_COMMITTED = "not_committed";
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
 * Called before the write connection is even opened (see
 * withWriteTransaction, which every write op in this module goes through),
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
 * One origin pair as a Map key, joined on NUL because a databaseUuid is free
 * text: any printable separator is a character some uuid could itself
 * contain, and a key collision here would refuse a track as duplicate_track
 * when it is not in the playlist at all. `uuid` must never be null: template
 * coercion turns `null` into the four characters "null", which would then
 * collide with an entry whose databaseUuid genuinely is that literal
 * string. A resolved track's uuid is never null -- resolveOrigins already
 * refused one that is -- so the only null this module ever sees is a
 * PlaylistEntity row's own `databaseUuid`, which the caller below skips
 * rather than passing in here.
 */
function pairKey(uuid: string, trackId: number): string {
  return `${uuid}\u0000${trackId}`;
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
/** Exported for src/store/track-metadata.ts. */
export function rollback(db: DatabaseSync): void {
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
/** Exported for src/store/track-metadata.ts. */
export function mapWriteError(e: unknown, subject: string, mdbPath: string): EngineError {
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
 * `EngineError`. A body that has already written something rolls back before
 * returning that error, but this function rolls back on that branch too
 * rather than relying on it: `rollback` is a no-op when there is no
 * transaction left to undo, and a body that forgot would otherwise leave the
 * open transaction to `db.close()` -- correct today, and only by accident.
 *
 * `isEngineError`, not a second return channel, is what tells `body`'s
 * success value apart from its failure one: this module already exports
 * that check for callers, so reusing it here means a body never has to wrap
 * its result to disambiguate the two.
 */
/** Exported for src/store/track-metadata.ts. */
export async function withWriteTransaction<T extends object>(
  mdbPath: string,
  uuid: string,
  subject: string,
  opts: {
    backupDir: string;
    /**
     * Test seam only. Runs after the snapshot and before the write connection
     * opens -- the window in which Engine DJ can still change a row this call
     * already pre-checked. No production caller passes it.
     */
    beforeLock?: () => void;
  },
  body: (db: DatabaseSync) => T | EngineError,
): Promise<(T & { library: LibraryRef; backup_path: string }) | EngineError> {
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
  opts.beforeLock?.();

  let db: DatabaseSync | undefined;
  let open = false;
  let commit: CommitState = "not yet";
  try {
    db = new DatabaseSync(mdbPath);
    open = true;
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("BEGIN IMMEDIATE");

    const result = body(db);
    if (isEngineError(result)) {
      rollback(db);
      return result;
    }

    commit = "maybe";
    db.exec("COMMIT");
    commit = "yes";

    const verifyErr = verifyAfterCommit(db, subject, backupPath);
    if (verifyErr) return verifyErr;

    // Filled in here, alongside backup_path, for the same reason: it is the
    // one place that knows the write succeeded, and doing it per-op would let
    // a new op ship without it.
    const library: LibraryRef = { uuid, path: redactPath(mdbPath) };

    // Every undo step carries the library too, and for a sharper reason than
    // symmetry: a caller replaying an undo sends `undo.arguments` and nothing
    // else, so without it the replay resolves whatever library is the default
    // at replay time. A USB drive and its copy hold the same playlist ids and
    // the same track ids, so such a replay lands on the wrong disk and
    // expect_track_ids agrees -- both sides having been edited the same way.
    //
    // By path, not by uuid: a library and its clone on a second drive share a
    // uuid (see store/backup.ts, which tags snapshots by path for exactly
    // that), and a uuid could not say which of the two to undo in. A path
    // names one. If that drive has since moved, the replay fails loudly with
    // library_not_found rather than quietly editing the other copy.
    //
    // Injected here rather than in each op so a new op cannot ship without it.
    const withUndo = result as { undo?: UndoStep[] };
    if (Array.isArray(withUndo.undo)) {
      withUndo.undo = withUndo.undo.map((step) => ({
        ...step,
        arguments: { library: library.path, ...step.arguments },
      }));
    }
    return { ...result, library, backup_path: backupPath };
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

      // Compared as pairs, in the same direction the write goes: each
      // existing entry's stored (databaseUuid, trackId) against the pairs
      // the requested tracks resolve to -- which is exactly what
      // UNIQUE (listId, databaseUuid, trackId) will compare when the INSERT
      // runs. Its value is failing fast: before the snapshot is copied and
      // before a write transaction opens, with a message naming the track,
      // rather than a UNIQUE-constraint violation surfacing from inside a
      // transaction and getting mapped back to the same code.
      //
      // The reverse direction -- resolving each entry back to a local track
      // and asking whether the request names it -- looks equivalent and is
      // strictly weaker, on two counts. First, it is not what gets compared:
      // UNIQUE (listId, databaseUuid, trackId) compares the pair itself, so
      // the pair form is exactly that comparison run early, while the
      // reverse form goes through Track and answers a related but different
      // question. Second, where two Track rows share one origin pair the
      // reverse form has to pick one and can miss the other -- but Engine's
      // own C_originDatabaseUuid_originTrackId UNIQUE constraint (see the
      // ENTRY_TRACK_MATCH comment in playlists.ts) forbids a real library
      // from ever holding that state; it is reachable at all only in this
      // project's own fixture, whose generated schema omits that constraint
      // (see tests/playlist-edit.test.ts). The pair form also drops one
      // unindexed Track scan per existing entry from a path that runs before
      // every add.
      //
      // Neither form can catch more than the constraint itself: an entry
      // whose stored pair no longer names any local track -- what a library
      // looks like right after a re-origination moved a track's origin on
      // without updating the entries naming its old one -- is not a
      // duplicate of anything, because nothing in the database still says
      // that entry and the requested track are the same one. That is a
      // property of the data, not a gap in the check.
      const wanted = new Map<string, number>();
      for (let i = 0; i < refs.length; i++) wanted.set(pairKey(refs[i]!.uuid, refs[i]!.trackId), trackIds[i]!);
      const existing = precheck
        .prepare("SELECT trackId, databaseUuid FROM PlaylistEntity WHERE listId = ?")
        .all(listId) as { trackId: number; databaseUuid: string | null }[];
      for (const e of existing) {
        // A null databaseUuid names a malformed entry (see OrderedEntry in
        // playlists.ts), never a real origin pair -- no resolved track can
        // match it, since resolveOrigins already refuses a null uuid. Keying
        // it would collide with pairKey's own null-coercion trap; skipping
        // it is what the old `= NULL` comparison did for free, since that
        // matches no row.
        if (e.databaseUuid === null) continue;
        const clash = wanted.get(pairKey(e.databaseUuid, e.trackId));
        if (clash !== undefined) {
          return err(
            "duplicate_track",
            `Track ${clash} is already in playlist ${listId}; Engine allows a track in a playlist only once.`,
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
    // expect_track_ids, not bare positions: this is the one moment the
    // server knows exactly which tracks landed at those positions, and a
    // playlist that changed between this edit and the undo would otherwise
    // have the undo remove whatever now sits there -- silently, and with no
    // way for the caller to notice. The ids are the caller's own local track
    // ids, which is what remove_tracks_from_playlist compares against (it
    // resolves each entry's stored origin pair back to a local track the
    // same way). Stale list, refused undo; unchanged list, the undo runs.
    return {
      playlist_id: listId,
      tracks_added: trackRefs.length,
      positions,
      undo: [
        {
          tool: "remove_tracks_from_playlist",
          arguments: { playlist_id: listId, positions, expect_track_ids: trackIds },
        },
      ],
      undo_complete: true,
    };
  });
}

/**
 * The local `Track.id` that carries a given origin pair, or null if none
 * does -- the reverse of resolveOrigins, going from a PlaylistEntity row's
 * stored (databaseUuid, trackId) back to the local row a caller's
 * expectTrackIds and the response's `removed[].track_id` are expressed in.
 *
 * Used only by resolveRemoval, which genuinely needs that direction: it has
 * an entry and must say which local track it holds. addTracksToPlaylist's
 * duplicate check used to go through here too and no longer does -- it
 * compares origin pairs directly, which is both stronger and cheaper; see
 * the comment on that check. Where two Track rows share one origin pair this
 * function answers with whichever row the query returns first, which is
 * exactly why the duplicate check must not be built on it.
 */
function resolveLocalTrackId(db: DatabaseSync, uuid: string, trackId: number): number | null {
  const row = db
    .prepare("SELECT id FROM Track WHERE originDatabaseUuid = ? AND originTrackId = ?")
    .get(uuid, trackId) as { id: number } | undefined;
  return row ? row.id : null;
}

/**
 * Validates `positions` against a chain's current order -- in range, no
 * repeats -- and, when `expectTrackIds` is given, that each named position
 * still holds the track a caller who read the list earlier believed it did
 * (`null` there means "resolves to no local track", not "no expectation" --
 * see resolveLocalTrackId, above -- so a non-null value at that slot is a
 * mismatch, same as a wrong id would be at any other slot).
 * Resolves each surviving position to the entry id to delete and the
 * *local* track id it currently holds, translated from the stored origin
 * pair the same way addTracksToPlaylist's duplicate-track check does (null
 * if that pair no longer resolves to any local track).
 *
 * Called twice by removeTracksFromPlaylist, against two different reads of
 * the same chain, for the same reason resolveInsertAt is: once in the
 * pre-check, to fail fast, and again inside the transaction against the
 * chain BEGIN IMMEDIATE just locked -- the pre-check's read can be stale by
 * the time the lock is held.
 */
function resolveRemoval(
  db: DatabaseSync,
  listId: number,
  order: number[],
  positions: number[],
  expectTrackIds: (number | null)[] | undefined,
): { position: number; entryId: number; trackId: number | null }[] | EngineError {
  const seen = new Set<number>();
  for (const p of positions) {
    if (!Number.isInteger(p) || p < 1 || p > order.length) {
      return err(
        "invalid_position",
        `Playlist ${listId} has ${order.length} entries; each position must be between 1 and ${order.length}.`,
        { detail: NOT_COMMITTED },
      );
    }
    if (seen.has(p)) {
      return err("invalid_position", `Position ${p} is named more than once.`, { detail: NOT_COMMITTED });
    }
    seen.add(p);
  }
  if (expectTrackIds && expectTrackIds.length !== positions.length) {
    return err(
      "invalid_position",
      `expectTrackIds has ${expectTrackIds.length} entries but positions has ${positions.length}.`,
      { detail: NOT_COMMITTED },
    );
  }

  const entryAt = db.prepare("SELECT trackId, databaseUuid FROM PlaylistEntity WHERE id = ?");
  const plan: { position: number; entryId: number; trackId: number | null }[] = [];
  for (let i = 0; i < positions.length; i++) {
    const position = positions[i]!;
    const entryId = order[position - 1]!;
    const row = entryAt.get(entryId) as { trackId: number; databaseUuid: string };
    const trackId = resolveLocalTrackId(db, row.databaseUuid, row.trackId);
    if (expectTrackIds && expectTrackIds[i] !== trackId) {
      return err(
        "invalid_position",
        `Position ${position} in playlist ${listId} does not hold track ${expectTrackIds[i]}; refusing to remove the wrong track.`,
        { detail: NOT_COMMITTED },
      );
    }
    plan.push({ position, entryId, trackId });
  }
  return plan;
}

/**
 * Removes one or more tracks from an existing playlist by their current
 * position.
 *
 * `trigger_before_delete_PlaylistEntity` (see gen-library.ts's copy of it,
 * taken verbatim from a real 3.0.2 library) relinks each deleted row's
 * predecessor onto its successor as SQLite processes the delete -- verified
 * for a row removed at the head, the middle and the tail, and, by
 * construction of the trigger itself, for a batch that removes several
 * rows, adjacent or not, in one statement. So this function does no chain
 * maintenance of its own; writing any would just be fighting Engine's own
 * trigger. What it does own is checking that the trigger's job actually
 * landed: its `WHEN OLD.trackId > 0` means a row with trackId <= 0 is
 * deleted *without* relinking, leaving its predecessor pointing at a row
 * that is now gone. No real library measured has such a row, but the
 * post-delete check below is the only thing that would ever notice one --
 * and it checks the surviving order against what was expected, not only
 * that some sound chain is left, because "sound" and "right" are different
 * questions and only the second one is what the caller asked for.
 *
 * Shares createPlaylist/addTracksToPlaylist's skeleton: a read-only
 * pre-check first, then withWriteTransaction.
 */
export async function removeTracksFromPlaylist(
  mdbPath: string,
  uuid: string,
  input: { listId: number; positions: number[]; expectTrackIds?: (number | null)[] },
  opts: { backupDir: string },
): Promise<EditResult | EngineError> {
  const { listId, positions, expectTrackIds } = input;
  const subject = `playlist ${listId}`;

  if (positions.length === 0) {
    return err("invalid_argument", "Name at least one position to remove.", { detail: NOT_COMMITTED });
  }

  // See createPlaylist for why this has to be checked before anything else
  // even tries to open the file.
  if (hasHotJournal(mdbPath)) return { ...libraryNeedsRecovery(), detail: NOT_COMMITTED };

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

      const plan = resolveRemoval(precheck, listId, gate.order, positions, expectTrackIds);
      if (isEngineError(plan)) return plan;
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

  return withWriteTransaction(mdbPath, uuid, subject, opts, (db) => {
    // Re-read: BEGIN IMMEDIATE is the first moment nothing else can change
    // the chain, and gating on the pre-check's read alone would be trusting
    // one that could already be stale.
    const gate = gateChain(db, listId);
    if (!gate.ok) {
      rollback(db);
      return err("playlist_chain_damaged", `Playlist ${listId}: ${gate.reason}. Nothing was changed.`, {
        detail: NOT_COMMITTED,
      });
    }

    // Re-resolved against this read of the chain, not the pre-check's: see
    // resolveRemoval's comment.
    const plan = resolveRemoval(db, listId, gate.order, positions, expectTrackIds);
    if (isEngineError(plan)) {
      rollback(db);
      return plan;
    }

    // What the chain must read back as once the deletes have landed: the
    // entries this call did not name, in their original order. Built here,
    // before the DELETE, from a walk of the chain BEGIN IMMEDIATE locked --
    // the same reason addTracksToPlaylist and reorderPlaylist build theirs
    // up front: a readback check derived from the writes it is meant to
    // verify checks nothing.
    const removedIndexes = new Set(plan.map((p) => p.position - 1));
    const originalRefs = gate.order.length > 0 ? walkFrom(db, listId, gate.order[0]!) : [];
    const expected = originalRefs.filter((_, i) => !removedIndexes.has(i));
    const survivors = gate.order.filter((_, i) => !removedIndexes.has(i));

    // One statement, no chain maintenance -- see this function's own
    // comment for why the trigger is trusted to relink around every row
    // this deletes, including a batch of several at once.
    const placeholders = plan.map(() => "?").join(", ");
    db.prepare(`DELETE FROM PlaylistEntity WHERE id IN (${placeholders})`).run(...plan.map((p) => p.entryId));

    // Gate *and* order, the same pairing add and reorder use, and spec §6
    // asks for here specifically. The gate catches what the trigger's WHEN
    // clause does not cover: a deleted row with trackId <= 0 leaves its
    // predecessor pointing at a row that no longer exists. sameOrder catches
    // the class the gate structurally cannot -- a chain that is still one
    // sound run but holds the wrong entries, or the wrong number of them,
    // which is what a delete that took the wrong row (or a trigger this code
    // does not know about) leaves behind.
    //
    // library_unreadable, not playlist_chain_damaged, and deliberately the
    // same code add and reorder use for their own post-check: the two mean
    // different things to a client. playlist_chain_damaged means the chain
    // was already broken before this edit and the edit refused to touch it;
    // this one means the edit's own verification disagreed with what it
    // wrote, so the transaction was rolled back. Both leave the library
    // unchanged (detail: not_committed); only the second says the library
    // did something this code cannot account for.
    const newHeadId = survivors.length > 0 ? survivors[0]! : 0;
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

    // Reported, and undone, in ascending position order rather than the
    // order the caller named them in -- the undo below depends on it.
    const removed = plan
      .slice()
      .sort((a, b) => a.position - b.position)
      .map((p) => ({ position: p.position, track_id: p.trackId }));

    // An entry whose stored origin pair matches no track in this library has
    // no track id to hand back, so no add_tracks_to_playlist call can
    // restore it: the DELETE above destroyed the only place that pair was
    // written down. Emitting a step for it anyway -- `track_ids: [null]` --
    // produced an undo its own tool's schema rejects, and the entry was gone
    // regardless. So no step is emitted for such a position, and the result
    // says so rather than implying a way back it does not have.
    const restorable = removed.filter((r) => r.track_id !== null);
    const lost = removed.filter((r) => r.track_id === null).map((r) => r.position);

    // Undo restores in that same ascending order, each step expressed
    // against the list as it will be *after* the previous step has run.
    // Restoring in ascending order means that immediately before the row
    // originally at position p is restored, every row originally before p
    // that *can* come back is present again -- either it was never removed,
    // or, being an earlier and already-restored entry, it is back in its
    // exact original spot -- and nothing originally at or after p has been
    // restored yet. So the number of rows preceding that slot at that moment
    // is p - 1 minus the rows originally before p that were removed and
    // cannot be restored. With nothing lost that is just `position - 1`
    // computed against the original position: removing positions 1 and 3
    // from a three-entry list restores 1 first (at "start") and then 3 (at
    // after_position: 2), reproducing the original order. Restoring 3 first
    // would compute that same after_position: 2 against a list from which 1
    // is *also* still missing -- a single surviving entry -- which is
    // already wrong (there is no position 2 to be after yet); ascending
    // order is what keeps every step's target position valid, not just
    // correct. Subtracting the lost rows is the same argument applied to a
    // list that will never get them back: a step that still counted them
    // would name a position the list does not reach, and be refused.
    const undo: UndoStep[] = restorable.map((r) => {
      const before = r.position - 1 - lost.filter((p) => p < r.position).length;
      return {
        tool: "add_tracks_to_playlist",
        arguments: {
          playlist_id: listId,
          track_ids: [r.track_id],
          at: before === 0 ? "start" : { after_position: before },
        },
      };
    });

    return {
      playlist_id: listId,
      tracks_removed: removed.length,
      removed,
      undo,
      undo_complete: lost.length === 0,
      ...(lost.length === 0
        ? {}
        : {
            undo_note:
              `Position${lost.length > 1 ? "s" : ""} ${lost.join(", ")} held an entry whose stored ` +
              `origin pair names no track in this library, so there is no track id to add back and ` +
              `no undo step can restore it. The other steps put everything else back; the only way ` +
              `back for ${lost.length > 1 ? "those entries" : "that entry"} is the snapshot at backup_path, ` +
              `which reverts the whole library.`,
          }),
    };
  });
}

/**
 * Validates `order` against a chain's current length: it must be a
 * permutation of `1..n` for `n = currentLength`, not a partial "move X to Y"
 * instruction. That is deliberate -- a full permutation is the only shape
 * that can catch a wrong length, a repeat, a zero, a negative or an
 * out-of-range value in one pass; a move instruction cannot name any of
 * those at all. Length is checked first and independently of range, so a
 * too-short or too-long `order` is reported as such rather than as an
 * in-range element failing to cover the tail.
 *
 * Called twice by reorderPlaylist, against two different reads of the same
 * chain, for the same reason resolveInsertAt and resolveRemoval are: once in
 * the pre-check, to fail fast, and again inside the transaction against the
 * chain BEGIN IMMEDIATE just locked -- the pre-check's read can be stale by
 * the time the lock is held.
 */
function validatePermutation(order: number[], currentLength: number, listId: number): EngineError | undefined {
  if (order.length !== currentLength) {
    return err(
      "invalid_position",
      `Playlist ${listId} has ${currentLength} entries; order must name exactly that many positions.`,
      { detail: NOT_COMMITTED },
    );
  }
  const seen = new Set<number>();
  for (const p of order) {
    if (!Number.isInteger(p) || p < 1 || p > currentLength) {
      return err(
        "invalid_position",
        `order must be a permutation of 1..${currentLength}; ${p} is out of range.`,
        { detail: NOT_COMMITTED },
      );
    }
    if (seen.has(p)) {
      return err("invalid_position", `order names position ${p} more than once.`, { detail: NOT_COMMITTED });
    }
    seen.add(p);
  }
  return undefined;
}

/**
 * Reorders an existing playlist's entries to a caller-given permutation of
 * its current order.
 *
 * Unlike add/remove, this rewrites links only -- no INSERT, no DELETE -- so
 * none of Engine's PlaylistEntity triggers fire and there is no trigger
 * behaviour to trust or verify here, only the links this function writes
 * itself. `order[i]` names the *current* 1-based position of the track that
 * should end up at position `i + 1` (see validatePermutation for why the
 * spec takes a full permutation rather than a move instruction). Only the
 * entries whose successor actually changes get an UPDATE -- measured on a
 * real library, moving an entry from the middle to the front took exactly
 * two updates, and the identity permutation writes no PlaylistEntity row at
 * all. It is still not a no-op: like every other op here it stamps
 * `Playlist.lastEditTime`, and the session's snapshot is copied before the
 * body ever runs, so the identity case costs a timestamp and (once per
 * session) a snapshot. Left that way deliberately -- "did this permutation
 * change anything" can only be answered honestly after BEGIN IMMEDIATE, by
 * which point the snapshot is already taken, and an edit that reports
 * success without touching lastEditTime would be the one op whose result
 * Engine cannot see.
 *
 * Shares createPlaylist/addTracksToPlaylist/removeTracksFromPlaylist's
 * skeleton: a read-only pre-check first, then withWriteTransaction.
 */
export async function reorderPlaylist(
  mdbPath: string,
  uuid: string,
  input: { listId: number; order: number[] },
  opts: { backupDir: string },
): Promise<EditResult | EngineError> {
  const { listId, order: requestedOrder } = input;
  const subject = `playlist ${listId}`;

  // See createPlaylist for why this has to be checked before anything else
  // even tries to open the file.
  if (hasHotJournal(mdbPath)) return { ...libraryNeedsRecovery(), detail: NOT_COMMITTED };

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

      const invalid = validatePermutation(requestedOrder, gate.order.length, listId);
      if (invalid) return invalid;
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

  return withWriteTransaction(mdbPath, uuid, subject, opts, (db) => {
    // Re-read: BEGIN IMMEDIATE is the first moment nothing else can change
    // the chain, and gating on the pre-check's read alone would be trusting
    // one that could already be stale. Read once and kept: the links rewritten
    // below are exactly the ones this check passed, not a second read of them.
    const rows = readChain(db, listId);
    const gate = checkChain(rows);
    if (!gate.ok) {
      rollback(db);
      return err("playlist_chain_damaged", `Playlist ${listId}: ${gate.reason}. Nothing was changed.`, {
        detail: NOT_COMMITTED,
      });
    }

    // Re-validated against this read of the chain, not the pre-check's: see
    // validatePermutation's comment.
    const invalid = validatePermutation(requestedOrder, gate.order.length, listId);
    if (invalid) {
      rollback(db);
      return invalid;
    }

    // The entry-identity chain the final order must read back as, built from
    // this walk -- taken *before* any UPDATE below -- rather than re-queried
    // afterwards, the same reason addTracksToPlaylist builds `expected` up
    // front: the readback check must not depend on the writes it is meant to
    // verify.
    const originalRefs = gate.order.length > 0 ? walkFrom(db, listId, gate.order[0]!) : [];
    const expected = requestedOrder.map((p) => originalRefs[p - 1]!);

    // newSeq[i] is the entry id that must sit at position i + 1 once this
    // returns; each entry's new successor is the id that follows it there,
    // or 0 for the new tail.
    const newSeq = requestedOrder.map((p) => gate.order[p - 1]!);
    const currentNext = new Map(rows.map((r) => [r.id, r.next]));
    const link = db.prepare("UPDATE PlaylistEntity SET nextEntityId = ? WHERE id = ?");
    for (let i = 0; i < newSeq.length; i++) {
      const entryId = newSeq[i]!;
      const newNext = i + 1 < newSeq.length ? newSeq[i + 1]! : 0;
      // Only entries whose link actually changes are written -- this avoids
      // n redundant PlaylistEntity writes for an identity permutation. It
      // does not make the call itself a no-op: lastEditTime is still stamped
      // below, and the session's snapshot was already copied before this ran
      // (see the doc-comment above).
      if (currentNext.get(entryId) !== newNext) link.run(newNext, entryId);
    }

    // Re-gated, not just re-walked: see addTracksToPlaylist's comment on the
    // same pairing. gateChain confirms the structure is still one sound
    // chain; sameOrder confirms the values landed in the requested order.
    const newHeadId = newSeq.length > 0 ? newSeq[0]! : 0;
    const finalGate = gateChain(db, listId);
    if (!finalGate.ok || (newSeq.length > 0 && !sameOrder(walkFrom(db, listId, newHeadId), expected))) {
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

    // The inverse permutation: if order[i] = p, then inverse[p - 1] = i + 1.
    // Applying it undoes this call exactly, because reorderPlaylist's own
    // effect is just "relabel positions by this permutation" -- composing a
    // permutation with its inverse is the identity.
    const inverse: number[] = new Array(requestedOrder.length);
    for (let i = 0; i < requestedOrder.length; i++) {
      inverse[requestedOrder[i]! - 1] = i + 1;
    }

    return {
      playlist_id: listId,
      undo: [{ tool: "reorder_playlist", arguments: { playlist_id: listId, order: inverse } }],
      undo_complete: true,
    };
  });
}
