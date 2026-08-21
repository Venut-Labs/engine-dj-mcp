import { rmSync } from "node:fs";
import { openSyncConnection } from "../store/connections.js";
import { readChangeCounter } from "../probe.js";
import { SIDECAR_DDL, SIDECAR_INDEXES } from "./schema.js";

export interface BuildArgs {
  mdbPath: string;
  outPath: string;
  uuid: string;
  schema: string;
  generation?: number;
}

/**
 * Full rebuild. There is no incremental path on purpose: lastEditTime is only
 * bumped by UPDATE of 21 Track columns, so it misses inserts, deletes, path
 * changes and play events, while a full rebuild is ~100 ms at 50k rows.
 */
export function buildSidecar(args: BuildArgs): { indexed: number; elapsed_ms: number } {
  const started = Date.now();
  const counter = readChangeCounter(args.mdbPath);
  rmSync(args.outPath, { force: true });

  const db = openSyncConnection(args.outPath, args.mdbPath);
  try {
    // Durability is irrelevant: the file is disposable and swapped in atomically.
    db.exec("PRAGMA journal_mode = OFF");
    db.exec("PRAGMA synchronous = OFF");
    for (const ddl of SIDECAR_DDL) db.exec(ddl);

    db.exec("BEGIN");
    db.exec(`INSERT INTO fts_track(rowid, title, artist, album, genre, comment, label)
             SELECT id, title, artist, album, genre, comment, label FROM engine.Track`);
    db.exec(`INSERT INTO fts_map(rowid, track_id) SELECT id, id FROM engine.Track`);
    // "Empty OR NULL", per the spec, not "NOT NULL": a zero-length blob
    // carries no cues and no beatgrid. Reading it as present made a track
    // has_cues: 1 in search while get_track_performance reported the same
    // blob as `empty` and audit_library left it out of no_cues.
    db.exec(`INSERT INTO track_derived(track_id, camelot, tempo, has_cues, has_grid)
             SELECT t.id,
                    camelot(t.key),
                    tempo(t.bpmAnalyzed, t.bpm),
                    CASE WHEN COALESCE(length(p.quickCues), 0) = 0 THEN 0 ELSE 1 END,
                    CASE WHEN COALESCE(length(p.beatData),  0) = 0 THEN 0 ELSE 1 END
             FROM engine.Track t
             LEFT JOIN engine.PerformanceData p ON p.trackId = t.id`);
    db.exec("COMMIT");

    for (const ix of SIDECAR_INDEXES) db.exec(ix);

    const indexed = Number((db.prepare("SELECT COUNT(*) c FROM track_derived").get() as any).c);
    db.prepare(`INSERT INTO index_meta (library_uuid, schema_version, change_counter, built_at, generation)
                VALUES (?,?,?,?,?)`)
      .run(args.uuid, args.schema, counter, Math.floor(started / 1000), args.generation ?? 1);
    return { indexed, elapsed_ms: Date.now() - started };
  } catch (e) {
    rmSync(args.outPath, { force: true });
    throw e;
  } finally {
    db.close();
  }
}
