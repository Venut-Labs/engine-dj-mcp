// src/store/write.ts
//
// The only code in this project that writes to a user's Engine library, and
// it runs only when the server was started with --allow-writes.
//
// The read path is deliberately not reused. Queries run in a forked child
// whose connection is opened readOnly: true, and that guarantee is the
// product's core promise -- teaching it to write would dissolve it for reads
// as well. Writes therefore get their own short-lived connection here:
// open, one transaction, verify, commit, close.
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
      return err("duplicate_track", `Track ${id} appears more than once; Engine allows a track in a playlist only once.`);
    }
    seen.add(id);
  }
  const stmt = db.prepare(
    "SELECT originDatabaseUuid AS uuid, originTrackId AS trackId FROM Track WHERE id = ?",
  );
  const refs: OriginRef[] = [];
  for (const id of trackIds) {
    const row = stmt.get(id) as { uuid: string | null; trackId: number | null } | undefined;
    if (!row || !row.uuid || !row.trackId) {
      return err("unknown_track", `No track with id ${id} in this library.`);
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
  if (!title) return err("invalid_argument", "A playlist needs a non-empty title.");

  const backupPath = await snapshotLibrary(mdbPath, uuid, opts.backupDir);
  if (typeof backupPath !== "string") return backupPath;

  let db: DatabaseSync | undefined;
  let open = false;
  try {
    db = new DatabaseSync(mdbPath);
    open = true;
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("BEGIN IMMEDIATE");

    const refs = resolveOrigins(db, input.trackIds);
    if (!Array.isArray(refs)) {
      db.exec("ROLLBACK");
      return refs;
    }

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

    const fk = db.prepare("PRAGMA foreign_key_check").all();
    if (fk.length > 0) {
      db.exec("ROLLBACK");
      return err("library_unreadable", `Writing "${title}" would have broken a foreign key; nothing was changed.`);
    }
    if (ids.length > 0 && !sameOrder(walkFrom(db, listId, ids[0]!), refs)) {
      db.exec("ROLLBACK");
      return err("library_unreadable", `The entry chain for "${title}" did not read back as written; nothing was changed.`);
    }
    const tails = db
      .prepare("SELECT COUNT(*) AS c FROM Playlist WHERE parentListId = 0 AND nextListId = 0")
      .get() as { c: number };
    if (tails.c !== 1) {
      db.exec("ROLLBACK");
      return err("library_unreadable", `The playlist chain has ${tails.c} tails after writing "${title}"; nothing was changed.`);
    }

    db.exec("COMMIT");

    const integrity = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
    if (integrity.integrity_check !== "ok") {
      return err(
        "library_unreadable",
        `The database reports "${integrity.integrity_check}" after writing "${title}". A snapshot from before the write is at ${backupPath}.`,
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
    if (/UNIQUE constraint failed: Playlist\.title/i.test(msg) || /C_NAME_UNIQUE_FOR_PARENT/i.test(msg)) {
      return err("playlist_exists", `A playlist called "${title}" already exists in this library.`);
    }
    if (/SQLITE_BUSY|database is locked/i.test(msg)) {
      return err("library_busy", "The library is locked by Engine DJ or a player. Close it and try again.");
    }
    if (/readonly|attempt to write a readonly database/i.test(msg)) {
      return err("library_unreadable", `The library at ${mdbPath} cannot be written to.`);
    }
    return err("library_unreadable", `Writing "${title}" failed: ${msg}`);
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed */
    }
  }
}
