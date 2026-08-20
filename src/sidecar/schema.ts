export const SIDECAR_DDL = [
  `CREATE VIRTUAL TABLE fts_track USING fts5(
     title, artist, album, genre, comment, label,
     tokenize='unicode61 remove_diacritics 2')`,
  `CREATE TABLE fts_map (rowid INTEGER PRIMARY KEY, track_id INTEGER UNIQUE)`,
  `CREATE TABLE track_derived (
     track_id INTEGER PRIMARY KEY,
     camelot TEXT, tempo REAL,
     has_cues INTEGER, has_grid INTEGER)`,
  `CREATE TABLE index_meta (
     library_uuid TEXT, schema_version TEXT,
     change_counter INTEGER, built_at INTEGER, generation INTEGER)`,
] as const;

export const SIDECAR_INDEXES = [
  `CREATE INDEX ix_derived_camelot ON track_derived(camelot)`,
  `CREATE INDEX ix_derived_tempo ON track_derived(tempo)`,
] as const;
