import { DatabaseSync } from "node:sqlite";
import { registerFunctions } from "../semantics.js";

/**
 * Connection A — the one the model reaches through.
 *
 * m.db is the MAIN database and is opened readOnly, so the restriction is a
 * property of the file descriptor rather than a PRAGMA. The inverse layout
 * (sidecar as main, m.db attached read-only) was rejected: SQL-level
 * `ATTACH '<m.db>' AS rw` escapes it and can write to the user's library.
 * PRAGMA query_only was rejected too, because SQL can turn it back off.
 */
export function openQueryConnection(mdbPath: string, sidecar: string | null): DatabaseSync {
  const db = new DatabaseSync(mdbPath, { readOnly: true });
  db.exec("PRAGMA busy_timeout = 3000");
  if (sidecar) db.exec(`ATTACH DATABASE 'file:${sidecar}?mode=ro' AS side`);
  registerFunctions(db);
  return db;
}

/** Connection B — used only by our own rebuild code, never exposed to the model. */
export function openSyncConnection(sidecar: string, mdbPath: string): DatabaseSync {
  const db = new DatabaseSync(sidecar);
  db.exec("PRAGMA busy_timeout = 3000");
  db.exec(`ATTACH DATABASE 'file:${mdbPath}?mode=ro' AS engine`);
  registerFunctions(db);
  return db;
}

/** Re-attach the sidecar after an atomic swap; rename() alone is invisible. */
export function reattachSidecar(db: DatabaseSync, sidecar: string): void {
  try { db.exec("DETACH DATABASE side"); } catch { /* not attached yet */ }
  db.exec(`ATTACH DATABASE 'file:${sidecar}?mode=ro' AS side`);
}
