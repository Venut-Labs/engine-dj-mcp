// src/store/write.ts
//
// The only code in this project that writes to a user's Engine library, and
// it runs only when the server was started with --allow-writes.
//
// The read path is deliberately not reused. Queries run in a forked child
// whose connection is opened readOnly: true, and that guarantee is the
// product's core promise -- teaching it to write would dissolve it for reads
// as well. Writes therefore get their own short-lived connection here:
// validate read-only, snapshot, open, one transaction, verify, commit, close.
import { DatabaseSync } from "node:sqlite";
import { err, type EngineError } from "../errors.js";
import { snapshotLibrary } from "./backup.js";

export interface CreatePlaylistResult {
  playlist_id: number;
  title: string;
  tracks_added: number;
  backup_path: string;
}

interface OriginRef {
  uuid: string;
  trackId: number;
}

/**
 * `detail` discriminator values for the EngineError this module returns.
 * Stable across releases so a caller can decide "is the library still what
 * it was" without parsing message prose. Everything before COMMIT --
 * including validation that never reaches the database at all -- collapses
 * to the same NOT_COMMITTED answer; only the post-commit check below can
 * produce COMMITTED_UNVERIFIED, and that is the one case where backup_path
 * is also set, because it is the only case where restoring from it is ever
 * the right next step.
 */
const NOT_COMMITTED = "not_committed";
const COMMITTED_UNVERIFIED = "committed_unverified";

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
function walkFrom(db: DatabaseSync, listId: number, headId: number): OriginRef[] {
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

function sameOrder(a: OriginRef[], b: OriginRef[]): boolean {
  return a.length === b.length && a.every((x, i) => x.uuid === b[i]!.uuid && x.trackId === b[i]!.trackId);
}

export async function createPlaylist(
  mdbPath: string,
  uuid: string,
  input: { title: string; trackIds: number[] },
  opts: { backupDir: string },
): Promise<CreatePlaylistResult | EngineError> {
  const title = input.title.trim();
  if (!title) return err("invalid_argument", "A playlist needs a non-empty title.", { detail: NOT_COMMITTED });

  // Validate against a short-lived read-only connection before touching the
  // snapshot rotation or opening the library for writing at all.
  // snapshotLibrary keeps only the last KEEP copies (src/store/backup.ts);
  // snapshotting before checking the title means a user who mistypes it
  // repeatedly evicts every genuine pre-write backup from that window for
  // nothing. This pass only rules out the common case cheaply -- another
  // writer can still create the same title (or, in principle, the same
  // entry) between this check and the INSERT below, so the UNIQUE-constraint
  // catch further down stays in place as the backstop for that race and
  // must still report it correctly, not as a generic failure.
  let refs: OriginRef[] | EngineError;
  {
    const precheck = new DatabaseSync(mdbPath, { readOnly: true });
    try {
      const exists = precheck.prepare("SELECT 1 FROM Playlist WHERE title = ? AND parentListId = 0").get(title);
      if (exists) {
        return err("playlist_exists", `A playlist called "${title}" already exists in this library.`, {
          detail: NOT_COMMITTED,
        });
      }
      refs = resolveOrigins(precheck, input.trackIds);
    } finally {
      precheck.close();
    }
  }
  if (!Array.isArray(refs)) return refs;

  const backupPath = await snapshotLibrary(mdbPath, uuid, opts.backupDir);
  if (typeof backupPath !== "string") return backupPath;

  let db: DatabaseSync | undefined;
  let open = false;
  try {
    db = new DatabaseSync(mdbPath);
    open = true;
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("BEGIN IMMEDIATE");

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

    // Scoped to the one table this write touches. Unscoped, foreign_key_check
    // walks every foreign key in the schema, and these libraries accumulate
    // cross-library debris that is already orphaned before we ever open the
    // file (src/playlists.ts:52-58) -- an unscoped check would roll back a
    // perfectly good write and blame it for damage that predates it.
    const fk = db.prepare("PRAGMA foreign_key_check(PlaylistEntity)").all();
    if (fk.length > 0) {
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

    db.exec("COMMIT");

    // quick_check, not integrity_check: after a successful COMMIT, SQLite's
    // own durability guarantee already covers what a full integrity_check
    // would re-derive, at the cost of walking every page of what can be a
    // multi-gigabyte USB library on every single playlist creation.
    // quick_check skips the cross-index verification integrity_check does
    // and is still enough to catch structural damage from this write.
    const check = db.prepare("PRAGMA quick_check").get() as { quick_check: string };
    if (check.quick_check !== "ok") {
      return err(
        "library_unreadable",
        `The database reports "${check.quick_check}" after writing "${title}". A snapshot from before the write is at ${backupPath}.`,
        { detail: COMMITTED_UNVERIFIED, backup_path: backupPath },
      );
    }

    return { playlist_id: listId, title, tracks_added: refs.length, backup_path: backupPath };
  } catch (e) {
    if (open && db) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* no transaction in progress */
      }
    }
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
    return err("library_unreadable", `Writing "${title}" failed: ${msg}`, { detail: NOT_COMMITTED });
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed */
    }
  }
}
