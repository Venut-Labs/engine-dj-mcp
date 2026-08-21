import { DatabaseSync } from "node:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { cueFrame, emptyCue, type CueSlot } from "./blob-frames.js";

const TRACK_DDL = `CREATE TABLE Track (
 id INTEGER PRIMARY KEY AUTOINCREMENT, playOrder INTEGER, length INTEGER, bpm INTEGER, year INTEGER,
 path TEXT, filename TEXT, bitrate INTEGER, bpmAnalyzed REAL, albumArtId INTEGER, fileBytes INTEGER,
 title TEXT, artist TEXT, album TEXT, genre TEXT, comment TEXT, label TEXT, composer TEXT, remixer TEXT,
 key INTEGER, rating INTEGER, albumArt TEXT, timeLastPlayed DATETIME, isPlayed BOOLEAN, fileType TEXT,
 isAnalyzed BOOLEAN, dateCreated DATETIME, dateAdded DATETIME, isAvailable BOOLEAN,
 isMetadataOfPackedTrackChanged BOOLEAN, isPerfomanceDataOfPackedTrackChanged BOOLEAN,
 playedIndicator INTEGER, isMetadataImported BOOLEAN, pdbImportKey INTEGER, streamingSource TEXT,
 uri TEXT, isBeatGridLocked BOOLEAN, originDatabaseUuid TEXT, originTrackId INTEGER,
 streamingFlags INTEGER, explicitLyrics BOOLEAN, lastEditTime DATETIME, albumArtSourceHash CHAR(40),
 CONSTRAINT C_path UNIQUE (path))`;

const GENRES = ["Deep House", "Techno", "Melodic Techno", "Drum & Bass", "Minimal", "Dub Techno"];
const WORDS = ["dark", "rolling", "hypnotic", "warm", "peak", "tool", "acid", "dubby", "raw"];
const ARTISTS = ["Ämbient Ünit", "Nachtbräu", "Kollektiv", "Sonja Vex", "Björk Edit", "Röyksopp"];

/**
 * The two quickCues blobs a generated track can carry, in the real Engine
 * layout rather than as filler bytes.
 *
 * This matters more than it looks. Engine writes a full eight-slot blob to
 * every analysed track whether or not a pad is used, so "the blob exists"
 * and "a cue is set" are different questions with different answers — and a
 * fixture that wrote `Buffer.alloc(128)` could not tell them apart, because
 * neither blob decodes at all. `has_cues` is now computed by decoding, so a
 * generator that emits undecodable bytes would make every track cue-less and
 * every assertion about the flag vacuous in the same direction.
 *
 * CUE_SET carries a hot cue in slot 7 at a sample offset inside every
 * generated track; NO_CUE_SET is Engine's ordinary analysed-but-untouched
 * blob, eight slots all at the -1.0 sentinel.
 */
const CUE_SLOTS = 8;
const CUE_SET = cueFrame(
  Array.from({ length: CUE_SLOTS }, (_, i): CueSlot =>
    i === 7 ? { label: "", position: 44_100 * 30, colour: 0xff158ee2 } : emptyCue,
  ),
);
const NO_CUE_SET = cueFrame(Array.from({ length: CUE_SLOTS }, () => emptyCue));

/** Deterministic PRNG so fixtures are reproducible across runs. */
function rng(seed: number) {
  let s = seed;
  return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

/**
 * `uuid` and `marker` exist for tests that need two libraries to be *told
 * apart*. Without them every fixture of the same schema version shares one
 * uuid and one set of generated titles, so a test that selected the wrong
 * library would pass exactly as happily as one that selected the right one
 * -- and the sidecars, keyed by uuid, would land on top of each other.
 * `marker` is prefixed to every title, so an FTS search for it returns rows
 * from that library and no other.
 */
export function makeLibrary(
  dir: string,
  opts: {
    tracks?: number;
    schema?: [number, number, number];
    uuid?: string;
    marker?: string;
  } = {},
): string {
  const n = opts.tracks ?? 500;
  const [maj, min, pat] = opts.schema ?? [3, 0, 2];
  const db2 = join(dir, "Engine Library", "Database2");
  mkdirSync(db2, { recursive: true });
  const dbPath = join(db2, "m.db");
  rmSync(dbPath, { force: true });

  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE Information (id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT,
    schemaVersionMajor INTEGER, schemaVersionMinor INTEGER, schemaVersionPatch INTEGER,
    currentPlayedIndiciator INTEGER, lastRekordBoxLibraryImportReadCounter INTEGER)`);
  db.exec(TRACK_DDL);
  db.exec(`CREATE TABLE PerformanceData (trackId INTEGER PRIMARY KEY, trackData BLOB,
    overviewWaveFormData BLOB, beatData BLOB, quickCues BLOB, loops BLOB,
    thirdPartySourceId INTEGER, activeOnLoadLoops INTEGER)`);
  db.exec(`CREATE TABLE Playlist (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT,
    parentListId INTEGER, isPersisted BOOLEAN, nextListId INTEGER, lastEditTime DATETIME,
    isExplicitlyExported BOOLEAN)`);
  db.exec(`CREATE TABLE PlaylistEntity (id INTEGER PRIMARY KEY AUTOINCREMENT, listId INTEGER,
    trackId INTEGER, databaseUuid TEXT, nextEntityId INTEGER, membershipReference INTEGER)`);
  for (const ix of ["title", "artist", "album", "genre", "key", "rating", "year", "dateAdded", "length"]) {
    db.exec(`CREATE INDEX index_Track_${ix} ON Track(${ix})`);
  }
  db.exec(`CREATE INDEX index_Track_bpmAnalyzed ON Track(CAST(bpmAnalyzed + 0.5 AS int))`);

  const uuid = opts.uuid ?? "00000000-0000-4000-8000-0000000000" + String(maj).padStart(2, "0");
  // Measured on two independent real Engine libraries: currentPlayedIndiciator
  // is a 64-bit value far outside Number.MAX_SAFE_INTEGER (9007199254740991),
  // not a corrupt or unusual one. A fixture that wrote 0 here let the code
  // and the fixture agree with each other and disagree with reality -- the
  // same failure shape as the BPM scaling defect this project already had to
  // correct once.
  const REAL_CURRENT_PLAYED_INDICATOR = -8676408967926364917n;
  db.prepare(`INSERT INTO Information (uuid, schemaVersionMajor, schemaVersionMinor,
    schemaVersionPatch, currentPlayedIndiciator, lastRekordBoxLibraryImportReadCounter)
    VALUES (?,?,?,?,?,0)`).run(uuid, maj, min, pat, REAL_CURRENT_PLAYED_INDICATOR);

  const r = rng(42);
  const pick = <T>(a: T[]) => a[Math.floor(r() * a.length)]!;
  const now = Math.floor(Date.now() / 1000);

  const ins = db.prepare(`INSERT INTO Track (id,length,bpm,year,path,filename,bitrate,bpmAnalyzed,
    fileBytes,title,artist,album,genre,comment,label,key,rating,timeLastPlayed,isPlayed,fileType,
    isAnalyzed,dateAdded,isAvailable,lastEditTime,originDatabaseUuid,originTrackId)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insP = db.prepare(`INSERT INTO PerformanceData (trackId,beatData,quickCues) VALUES (?,?,?)`);

  db.exec("BEGIN");
  for (let i = 1; i <= n; i++) {
    const bpm = 118 + Math.floor(r() * 22);
    const played = r() < 0.6 ? now - Math.floor(r() * 86400 * 900) : null;
    ins.run(
      // bpm is stored at face value (not times 100, as rekordbox does).
      i, 180 + Math.floor(r() * 300), bpm, 2005 + Math.floor(r() * 21),
      `../Music/lib/${i % 50}/t${i}.mp3`, `t${i}.mp3`, 320, bpm + r() * 0.4,
      8_000_000 + Math.floor(r() * 4e6),
      `${opts.marker ? opts.marker + " " : ""}${pick(WORDS)} ${pick(WORDS)} ${i}`,
      pick(ARTISTS), `Album ${i % 40}`, pick(GENRES),
      r() < 0.3 ? pick(WORDS) : null, `Label ${i % 20}`,
      r() < 0.05 ? -1 : Math.floor(r() * 24), Math.floor(r() * 6),
      played, played ? 1 : 0, "mp3", r() < 0.9 ? 1 : 0,
      now - Math.floor(r() * 86400 * 1500), 1, now - Math.floor(r() * 86400 * 100),
      uuid, i,
    );
    const hasPerf = r() < 0.85;
    // `i % 4`, not another r(): drawing again here would shift the PRNG
    // sequence for every field generated after it and silently change every
    // other fixture in the suite. This keeps the rest byte-identical while
    // making "analysed" and "has a cue set" two different populations.
    const cueIsSet = hasPerf && i % 4 === 0;
    insP.run(i, hasPerf ? Buffer.alloc(64) : null, hasPerf ? (cueIsSet ? CUE_SET : NO_CUE_SET) : null);
  }
  db.exec("COMMIT");
  db.close();
  return dbPath;
}
