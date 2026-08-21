import { DatabaseSync } from "node:sqlite";
import { existsSync, openSync, readSync, closeSync } from "node:fs";
import { registerFunctions } from "../semantics.js";
import { EngineErrorException, libraryNeedsRecovery } from "../errors.js";

/**
 * SQLite's rollback-journal header magic (see aJournalMagic in sqlite3
 * source). A journal only needs recovery — is "hot" — once this has actually
 * been written to disk. A live writer whose whole transaction still fits in
 * the page cache never reaches this: nothing is hot until a page is forced
 * out to the journal, which is why an *active* transaction from a concurrent
 * writer (see the "concurrent writer" test) is a completely different case
 * from a *hot* journal left by a killed one.
 */
const HOT_JOURNAL_MAGIC = "d9d505f920a163d7";

/**
 * True when `<mdbPath>-journal` exists and carries SQLite's real hot-journal
 * magic, meaning a previous writer died mid-transaction with unflushed pages
 * on disk. SQLite itself will refuse to open such a database read-only (it
 * needs to roll the journal forward, which requires a write) and raises a
 * raw, unhelpful "attempt to write a readonly database" error. This lets
 * openQueryConnection detect the condition first and explain it instead.
 */
export function hasHotJournal(mdbPath: string): boolean {
  const journalPath = `${mdbPath}-journal`;
  if (!existsSync(journalPath)) return false;

  // A journal that exists but cannot be opened or read (a permissions
  // problem on the sibling file, say) is "cannot determine", not "is hot".
  // Folding that to false -- rather than throwing, or assuming the worst --
  // is a deliberate choice: this function's only three callers use a true
  // result to skip the real open/query attempt and report a specific,
  // actionable claim ("launch Engine DJ to recover it") without ever
  // checking the actual database. If the real problem is unrelated to a hot
  // journal, that claim would be false, and a healthy library would be
  // permanently unusable through this server for a reason relaunching
  // Engine DJ cannot fix. Returning false instead lets the real attempt
  // proceed and surface whatever is actually wrong through the paths that
  // already handle it as a structured error (library_busy,
  // query_process_crashed, ...).
  let fd: number;
  try {
    fd = openSync(journalPath, "r");
  } catch {
    return false;
  }
  try {
    const buf = Buffer.alloc(8);
    const n = readSync(fd, buf, 0, 8, 0);
    return n === 8 && buf.toString("hex") === HOT_JOURNAL_MAGIC;
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
}

/**
 * SQLite's "file:" URI filename syntax treats `#`, `?` and unescaped
 * whitespace as delimiters, so a raw path can misparse even once it is no
 * longer inside a SQL string literal. encodeURI leaves `#` alone (it is a
 * legal URI character, just not inside our path segment), hence the extra
 * replace.
 */
function toReadOnlyUri(p: string): string {
  return "file:" + encodeURI(p).replace(/#/g, "%23") + "?mode=ro";
}

/**
 * Connection A — the one the model reaches through.
 *
 * m.db is the MAIN database and is opened readOnly, so the restriction is a
 * property of the file descriptor rather than a PRAGMA. The inverse layout
 * (sidecar as main, m.db attached read-only) was rejected: SQL-level
 * `ATTACH '<m.db>' AS rw` escapes it and can write to the user's library.
 * PRAGMA query_only was rejected too, because SQL can turn it back off.
 *
 * The attach path is bound as a parameter, not interpolated into the SQL
 * text: a library directory containing an apostrophe (e.g. `Rock 'n' Roll`)
 * breaks out of a string literal built by concatenation.
 */
export function openQueryConnection(mdbPath: string, sidecar: string | null): DatabaseSync {
  if (hasHotJournal(mdbPath)) {
    // Never open the database writable to roll the journal forward
    // ourselves: writing to the user's library is the one thing this
    // project promises never to do. v1 detects and explains instead.
    //
    // The structured error is carried by the exception rather than
    // flattened to its message: this runs inside the forked worker, where
    // returning is not an option, and the parent used to re-stat the disk to
    // rediscover what this function already knew.
    throw new EngineErrorException(libraryNeedsRecovery());
  }
  const db = new DatabaseSync(mdbPath, { readOnly: true });
  db.exec("PRAGMA busy_timeout = 3000");
  if (sidecar) db.prepare("ATTACH DATABASE ? AS side").run(toReadOnlyUri(sidecar));
  registerFunctions(db, mdbPath);
  return db;
}

/** Connection B — used only by our own rebuild code, never exposed to the model. */
export function openSyncConnection(sidecar: string, mdbPath: string): DatabaseSync {
  const db = new DatabaseSync(sidecar);
  db.exec("PRAGMA busy_timeout = 3000");
  db.prepare("ATTACH DATABASE ? AS engine").run(toReadOnlyUri(mdbPath));
  registerFunctions(db, mdbPath);
  return db;
}

/** Re-attach the sidecar after an atomic swap; rename() alone is invisible. */
export function reattachSidecar(db: DatabaseSync, sidecar: string): void {
  try { db.exec("DETACH DATABASE side"); } catch { /* not attached yet */ }
  db.prepare("ATTACH DATABASE ? AS side").run(toReadOnlyUri(sidecar));
}
