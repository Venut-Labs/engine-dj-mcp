// src/store/track-metadata.ts
//
// update_track_metadata against a real library. The decisions live in
// track-metadata-plan.ts; this module reads rows, applies a plan and verifies
// it. Order (spec §6): hot journal, input rules, read-only pre-check, then --
// only if something would change -- the shared write transaction, where every
// row is read and planned AGAIN under the lock and that second reading decides.
import { DatabaseSync } from "node:sqlite";
import { err, isEngineError, libraryNeedsRecovery, type EngineError } from "../errors.js";
import { redactPath } from "../paths.js";
import { hasHotJournal } from "./connections.js";
import {
  NOT_COMMITTED,
  mapWriteError,
  rollback,
  withWriteTransaction,
  type LibraryRef,
  type UndoStep,
} from "./write.js";
import {
  planUpdates,
  sameStored,
  validateUpdates,
  TEXT_FIELDS,
  type CurrentRow,
  type FieldName,
  type Plan,
  type TrackUpdate,
} from "./track-metadata-plan.js";

export interface TrackMetadataResult {
  updated: number;
  unchanged: number;
  changed: { id: number; fields: FieldName[] }[];
  undo: UndoStep[];
  undo_complete: true;
}

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

/**
 * Types and ranges are settled in SQL, before a value reaches JS: node:sqlite
 * throws on an INTEGER beyond 2^53, and a REAL rating or a TEXT year is not a
 * value this tool could put back. Such a column comes back null and is listed
 * in `inexpressible`. The empty-origin test is the fix-origin trigger's own
 * WHEN, evaluated by SQLite, so it agrees with the trigger on TEXT '' (spec §3.3).
 */
const READ_ROW = `SELECT id,
  CASE WHEN typeof(genre) = 'text' THEN genre END AS genre, typeof(genre) AS genre_t,
  CASE WHEN typeof(comment) = 'text' THEN comment END AS comment, typeof(comment) AS comment_t,
  CASE WHEN typeof(label) = 'text' THEN label END AS label, typeof(label) AS label_t,
  CASE WHEN typeof(year) = 'integer' AND year BETWEEN -${MAX_SAFE} AND ${MAX_SAFE} THEN year END AS year,
  (typeof(year) = 'null' OR (typeof(year) = 'integer' AND year BETWEEN -${MAX_SAFE} AND ${MAX_SAFE})) AS year_ok,
  CASE WHEN typeof(rating) = 'integer' AND rating BETWEEN 0 AND 255 THEN rating END AS rating,
  (typeof(rating) = 'null' OR (typeof(rating) = 'integer' AND rating BETWEEN 0 AND 255)) AS rating_ok,
  (IFNULL(originTrackId, 0) = 0 OR IFNULL(originDatabaseUuid, '') = '') AS origin_empty,
  CAST(originDatabaseUuid AS TEXT) || '|' || CAST(originTrackId AS TEXT) AS origin
  FROM Track WHERE id = ?`;

type ReadRow = CurrentRow & { origin: string | null };

function readRows(db: DatabaseSync, ids: number[]): Map<number, ReadRow> {
  const stmt = db.prepare(READ_ROW);
  const out = new Map<number, ReadRow>();
  for (const id of ids) {
    const r = stmt.get(id) as Record<string, string | number | null> | undefined;
    if (!r) continue;
    const inexpressible: FieldName[] = [];
    for (const f of TEXT_FIELDS) {
      if (r[`${f}_t`] !== "text" && r[`${f}_t`] !== "null") inexpressible.push(f);
    }
    if (!r.year_ok) inexpressible.push("year");
    if (!r.rating_ok) inexpressible.push("rating");
    out.set(id, {
      id,
      genre: r.genre as string | null,
      comment: r.comment as string | null,
      label: r.label as string | null,
      year: r.year as number | null,
      rating: r.rating as number | null,
      inexpressible,
      originEmpty: r.origin_empty === 1,
      origin: r.origin as string | null,
    });
  }
  return out;
}

export async function updateTrackMetadata(
  mdbPath: string,
  uuid: string,
  input: { updates: TrackUpdate[] },
  opts: { backupDir: string; beforeLock?: () => void },
): Promise<(TrackMetadataResult & { library: LibraryRef; backup_path?: string }) | EngineError> {
  const { updates } = input;
  const ids = updates.map((u) => u.id);
  const subject = `${updates.length} track${updates.length === 1 ? "" : "s"}`;

  // First, before anything opens the file: see createPlaylist in write.ts.
  if (hasHotJournal(mdbPath)) return { ...libraryNeedsRecovery(), detail: NOT_COMMITTED };

  const invalid = validateUpdates(updates);
  if (invalid) return invalid;

  // Not the authority -- the transaction re-plans. This only spares a
  // snapshot for a call that is going to refuse anyway, or has nothing to do.
  let pre: Plan | EngineError;
  let precheck: DatabaseSync | undefined;
  try {
    precheck = new DatabaseSync(mdbPath, { readOnly: true });
    pre = planUpdates(updates, readRows(precheck, ids));
  } catch (e) {
    return mapWriteError(e, subject, mdbPath);
  } finally {
    try {
      precheck?.close();
    } catch {
      /* never opened */
    }
  }
  if (isEngineError(pre)) return pre;

  if (pre.writes.length === 0) {
    // Spec §5.5: no transaction, no snapshot, so no backup_path -- and
    // withWriteTransaction is not here to fill in `library`.
    return {
      updated: 0,
      unchanged: pre.unchanged.length,
      changed: [],
      undo: [],
      undo_complete: true,
      library: { uuid, path: redactPath(mdbPath) },
    };
  }

  return withWriteTransaction(mdbPath, uuid, subject, opts, (db) => {
    // Under BEGIN IMMEDIATE. Engine may have changed any of these rows while
    // the snapshot was being copied; what is read here decides (spec §6.5).
    const rows = readRows(db, ids);
    const plan = planUpdates(updates, rows);
    if (isEngineError(plan)) {
      rollback(db);
      return plan;
    }

    for (const w of plan.writes) {
      // Column names come from the FieldName union, never from caller text.
      const assignments = w.fields.map((f) => `${f} = ?`).join(", ");
      db.prepare(`UPDATE Track SET ${assignments} WHERE id = ?`).run(...w.fields.map((f) => w.set[f] ?? null), w.id);
    }

    const after = readRows(db, plan.writes.map((w) => w.id));
    for (const w of plan.writes) {
      const got = after.get(w.id);
      const landed =
        got !== undefined &&
        got.origin === rows.get(w.id)!.origin &&
        w.fields.every((f) => sameStored(f, got[f], w.set[f] ?? null));
      if (!landed) {
        rollback(db);
        return err("library_unreadable", `Track ${w.id} did not read back as written; nothing was changed.`, {
          detail: NOT_COMMITTED,
        });
      }
    }

    const result: TrackMetadataResult = {
      updated: plan.writes.length,
      unchanged: plan.unchanged.length,
      changed: plan.writes.map((w) => ({ id: w.id, fields: w.fields })),
      undo: plan.undo.length > 0 ? [{ tool: "update_track_metadata", arguments: { updates: plan.undo } }] : [],
      undo_complete: true,
    };
    return result;
  });
}
