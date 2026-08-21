/**
 * Version of *this* file's meaning, not of the Engine library's schema.
 *
 * The staleness probe compares the library's change counter, so a sidecar
 * only gets rebuilt when the library changes. That is right for content and
 * wrong for semantics: when a column starts meaning something different, an
 * untouched library would keep serving the old meaning from disk forever.
 * `index_meta.index_format` is stored on build and checked on load, so a
 * sidecar written by a different version of this code is treated as stale.
 *
 * 1 — the original columns.
 * 2 — `has_cues` changed from "a quickCues blob exists" to "a hot cue is
 *     actually set", which is a different answer for 278 of 281 real tracks.
 */
export const SIDECAR_FORMAT = 2;

export const SIDECAR_DDL = [
  `CREATE VIRTUAL TABLE fts_track USING fts5(
     title, artist, album, genre, comment, label,
     tokenize='unicode61 remove_diacritics 2')`,
  `CREATE TABLE fts_map (rowid INTEGER PRIMARY KEY, track_id INTEGER UNIQUE)`,
  // has_cues: a hot cue is actually set (the quickCues blob is decoded during
  // the build); has_grid: a beatData blob is present. The asymmetry is
  // measured, not an oversight -- see sidecar/build.ts.
  `CREATE TABLE track_derived (
     track_id INTEGER PRIMARY KEY,
     camelot TEXT, tempo REAL,
     has_cues INTEGER, has_grid INTEGER)`,
  `CREATE TABLE index_meta (
     library_uuid TEXT, schema_version TEXT,
     change_counter INTEGER, built_at INTEGER, generation INTEGER,
     index_format INTEGER)`,
] as const;

export const SIDECAR_INDEXES = [
  `CREATE INDEX ix_derived_camelot ON track_derived(camelot)`,
  `CREATE INDEX ix_derived_tempo ON track_derived(tempo)`,
] as const;
