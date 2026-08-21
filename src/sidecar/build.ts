import { rmSync } from "node:fs";
import { openSyncConnection } from "../store/connections.js";
import { readChangeCounter } from "../probe.js";
import { hasCueSet } from "../blobs/index.js";
import { SIDECAR_DDL, SIDECAR_INDEXES, SIDECAR_FORMAT } from "./schema.js";

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
 * changes and play events, while a full rebuild is ~240 ms at 50k rows (3 ms
 * on the real 257-track library it was measured against). About 100 ms of the
 * 50k figure is decoding quickCues for has_cues, which is the price of that
 * column answering "a cue is set" instead of "Engine analysed this".
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

    // Registered here rather than in semantics.ts, which is the set of
    // functions the *model* can call through run_sql: this one runs a zlib
    // inflate and a blob walk per row, so exposing it to arbitrary SQL would
    // hand out a way to make any query cost a full decode of the library.
    // The rebuild is the one place that needs it, and it runs once per
    // library change.
    //
    // hasCueSet never throws (nor does anything under it), so a corrupt blob
    // yields 0 rather than aborting a build over one bad row.
    db.function("has_cue_set", { deterministic: true }, (v: unknown) =>
      hasCueSet(v instanceof Uint8Array ? Buffer.from(v) : null) ? 1 : 0,
    );

    db.exec("BEGIN");
    db.exec(`INSERT INTO fts_track(rowid, title, artist, album, genre, comment, label)
             SELECT id, title, artist, album, genre, comment, label FROM engine.Track`);
    db.exec(`INSERT INTO fts_map(rowid, track_id) SELECT id, id FROM engine.Track`);
    // has_cues decodes the blob; has_grid tests that one is there. The
    // asymmetry is measured on 281 real blobs, not a shortcut:
    //
    //   quickCues is written to every analysed track with all eight slots at
    //   the -1.0 "unused" sentinel, so "the blob exists" is true for 281 of
    //   281 while a cue is set on 3. A DJ asking which tracks still need cue
    //   points was told none did, on a library where 255 of 257 do. Only
    //   decoding can tell those apart, and this is our code, not SQL.
    //
    //   beatData carries no equivalent "analysed but empty" state. All 281
    //   blobs decode, all 281 carry two markers in each of the two grids,
    //   the present-flag byte is 1 on all 281, and every implied tempo
    //   matches Track.bpmAnalyzed to within 0.5 BPM. Presence and a real
    //   grid have not once disagreed, because a beatgrid is produced by
    //   analysis where a cue is placed by a human. Decoding it would cost
    //   ~570 ms per rebuild at 50k tracks (measured: 2.95 ms for 257 blobs)
    //   to re-derive an answer already correct on every row available.
    //
    // "Empty OR NULL", not "NOT NULL", still holds for has_grid: a
    // zero-length blob carries no beatgrid. Reading it as present made a
    // track has_beatgrid: 1 in search while get_track_performance reported
    // the same blob as `empty`.
    db.exec(`INSERT INTO track_derived(track_id, camelot, tempo, has_cues, has_grid)
             SELECT t.id,
                    camelot(t.key),
                    tempo(t.bpmAnalyzed, t.bpm),
                    has_cue_set(p.quickCues),
                    CASE WHEN COALESCE(length(p.beatData),  0) = 0 THEN 0 ELSE 1 END
             FROM engine.Track t
             LEFT JOIN engine.PerformanceData p ON p.trackId = t.id`);
    db.exec("COMMIT");

    for (const ix of SIDECAR_INDEXES) db.exec(ix);

    const indexed = Number((db.prepare("SELECT COUNT(*) c FROM track_derived").get() as any).c);
    db.prepare(`INSERT INTO index_meta (library_uuid, schema_version, change_counter, built_at, generation, index_format)
                VALUES (?,?,?,?,?,?)`)
      .run(args.uuid, args.schema, counter, Math.floor(started / 1000), args.generation ?? 1, SIDECAR_FORMAT);
    return { indexed, elapsed_ms: Date.now() - started };
  } catch (e) {
    rmSync(args.outPath, { force: true });
    throw e;
  } finally {
    db.close();
  }
}
