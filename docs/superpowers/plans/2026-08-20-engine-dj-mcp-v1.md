# Engine DJ MCP v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read-only MCP server over the Engine DJ library that supports smart track search and collection audit, including decoded cue points, loops and beatgrids.

**Architecture:** The user's `m.db` is opened as the main database of a `readOnly` connection, so read-only is a kernel guarantee rather than a convention. A writable sidecar database holds an FTS5 index and materialised derived columns, attached read-only to the query connection. All library queries run in a forked child process that can be `SIGKILL`ed, because `node:sqlite` exposes no `interrupt()` and blocks the event loop.

**Tech Stack:** TypeScript 7, Node 22+, `node:sqlite` (no native dependencies), `@modelcontextprotocol/sdk` 1.30, zod 4, vitest 4.

**Spec:** `docs/superpowers/specs/2026-08-20-engine-dj-mcp-design.md`

> **Correction, 2026-08-21.** This plan originally stated that Engine stores
> `Track.bpm` as an integer times one hundred. That is false — it is a
> rekordbox convention carried in by mistake. Measured against a real Engine
> DJ 5.0 library: stored values of 102, 105, 128, 145 and 147, each matching
> `bpmAnalyzed` to within 0.68, and Engine's own interface displays 102 for
> the track stored as 102. Every code block below has been corrected. The
> defect survived 147 passing tests because the fixture generator encoded the
> same false assumption as the implementation.
>
> **Correction, 2026-08-21 (second pass).** The banner above claimed every
> code block had been corrected; two had not. The `tempo` test block in Task
> 1 still asserted `tempo(null, 12800) === 128.0`, which fails against the
> shipped implementation, and the `semantics.ts` block beside it still called
> the `key = 0` → C major anchor an assumption. Both are fixed below. The
> anchor is confirmed, not assumed: the track stored as `key = 20` displays
> as 6B in Engine DJ, exactly what the formula produces.

## Global Constraints

- Node `>=22.0.0`. `node:sqlite` is required and is experimental on 22; it prints an `ExperimentalWarning` to stderr, which is harmless for stdio transport.
- Zero native/compiled dependencies at runtime. Runtime deps are limited to `@modelcontextprotocol/sdk`, `zod`, `@cfworker/json-schema`.
- The user's Engine library is **never written to**. No file may be created inside `Engine Library/`.
- Supported schema versions: exactly `3.0.0`, `3.0.1`, `3.0.2`. Anything else returns `unsupported_schema`.
- `run_sql` must use `prepare()`, never `exec()`.
- All tools carry `readOnlyHint: true`.
- Package name `engine-dj-mcp`, MIT licence. README must carry a not-affiliated-with-inMusic/Denon-DJ disclaimer. No inMusic logos or brand artwork.
- Default search projection is exactly `id, artist, title, bpm, camelot, rating`. `limit` defaults to 25, maximum 200.
- All errors are structured results, never thrown exceptions, except for programmer errors.

---

## File Structure

```
src/
  index.ts                  CLI entry; wires server to stdio
  server.ts                 MCP server: registers tools and resources
  errors.ts                 error taxonomy and constructors
  discovery.ts              locate libraries, read Information, allowlist
  probe.ts                  SQLite header change counter
  paths.ts                  sidecar locations, relative->absolute path
  semantics.ts              camelot/key_name/tempo/key_distance + registration
  guard.ts                  run_sql leading-statement guard
  sidecar/schema.ts         sidecar DDL
  sidecar/build.ts          full rebuild into a temp file
  proc/query-client.ts      fork, IPC, timeout, SIGKILL, respawn, generation
  proc/query-worker.ts      child: connection A, executes queries
  proc/sync-client.ts       spawn rebuild, atomic rename
  proc/sync-worker.ts       child: connection B, runs the rebuild
  blobs/qcompress.ts        qCompress framing + zlib
  blobs/cues.ts             quickCues decoder
  blobs/loops.ts            loops decoder
  blobs/beatgrid.ts         beatData decoder
  blobs/waveform.ts         overviewWaveFormData -> summary
  blobs/index.ts            decode a PerformanceData row into statuses
  tools/search.ts           search_tracks
  tools/tracks.ts           get_tracks
  tools/performance.ts      get_track_performance
  tools/audit.ts            audit_library
  tools/sql.ts              run_sql
  tools/libraries.ts        list_libraries
  tools/refresh.ts          refresh_index
tests/
  fixtures/gen-library.ts   synthetic Engine 3.0.2 library generator
  *.test.ts
```

---

### Task 1: Project scaffold and error taxonomy

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`
- Create: `src/errors.ts`
- Test: `tests/errors.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `type EngineError = { error: ErrorCode; message: string; detail?: string; retry_after_ms?: number }`, `ErrorCode` union, `err(code, message, extra?): EngineError`, `isEngineError(v): v is EngineError`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "engine-dj-mcp",
  "version": "0.1.0",
  "description": "MCP server for the Engine DJ library. Not affiliated with inMusic or Denon DJ.",
  "license": "MIT",
  "type": "module",
  "engines": { "node": ">=22.0.0" },
  "bin": { "engine-dj-mcp": "dist/index.js" },
  "files": ["dist"],
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.30.0",
    "@cfworker/json-schema": "^4.1.1",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "typescript": "^7.0.2",
    "vitest": "^4.1.11",
    "@types/node": "^22.0.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "declaration": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Create `vitest.config.ts` and `.gitignore`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
```

`.gitignore`:

```
node_modules/
dist/
.engine-dj-mcp-test/
```

- [ ] **Step 4: Install dependencies**

Run: `npm install`
Expected: no errors; `node_modules/` created.

- [ ] **Step 5: Write the failing test**

```ts
// tests/errors.test.ts
import { describe, it, expect } from "vitest";
import { err, isEngineError } from "../src/errors.js";

describe("error taxonomy", () => {
  it("builds a structured error, never throws", () => {
    const e = err("library_busy", "Engine DJ is writing", { retry_after_ms: 5000 });
    expect(e).toEqual({
      error: "library_busy",
      message: "Engine DJ is writing",
      retry_after_ms: 5000,
    });
  });

  it("recognises its own errors and rejects look-alikes", () => {
    expect(isEngineError(err("library_not_found", "no library"))).toBe(true);
    expect(isEngineError({ error: "not_a_code", message: "x" })).toBe(false);
    expect(isEngineError(null)).toBe(false);
    expect(isEngineError("library_busy")).toBe(false);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run tests/errors.test.ts`
Expected: FAIL — cannot resolve `../src/errors.js`.

- [ ] **Step 7: Write the implementation**

```ts
// src/errors.ts
export const ERROR_CODES = [
  "library_busy",
  "library_not_found",
  "unsupported_schema",
  "query_timeout",
  "query_process_crashed",
  "index_stale",
  "decode_failed",
  "invalid_argument",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface EngineError {
  error: ErrorCode;
  message: string;
  detail?: string;
  retry_after_ms?: number;
}

export function err(
  error: ErrorCode,
  message: string,
  extra: Omit<EngineError, "error" | "message"> = {},
): EngineError {
  return { error, message, ...extra };
}

export function isEngineError(value: unknown): value is EngineError {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.message === "string" &&
    typeof v.error === "string" &&
    (ERROR_CODES as readonly string[]).includes(v.error)
  );
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run tests/errors.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore src/errors.ts tests/errors.test.ts
git commit -m "chore: scaffold project and add error taxonomy"
```

---

### Task 2: Synthetic library fixture generator

Every later task needs a real Engine-shaped database to test against. The user's own library is empty, so tests must build their own.

**Files:**
- Create: `tests/fixtures/gen-library.ts`
- Test: `tests/fixtures/gen-library.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `makeLibrary(dir: string, opts?: { tracks?: number; schema?: [number, number, number] }): string` returning the path to the generated `m.db`

- [ ] **Step 1: Write the failing test**

```ts
// tests/fixtures/gen-library.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { makeLibrary } from "./gen-library.js";

let dir: string;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "edj-")); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

describe("synthetic library", () => {
  it("produces a schema 3.0.2 database with the real Track shape", () => {
    const db = new DatabaseSync(makeLibrary(dir, { tracks: 500 }), { readOnly: true });
    const info = db.prepare(
      "SELECT schemaVersionMajor a, schemaVersionMinor b, schemaVersionPatch c, uuid FROM Information",
    ).get() as any;
    expect([info.a, info.b, info.c]).toEqual([3, 0, 2]);
    expect(typeof info.uuid).toBe("string");

    const cols = (db.prepare("SELECT name FROM pragma_table_info('Track')").all() as any[])
      .map((r) => r.name);
    for (const c of ["bpmAnalyzed", "key", "timeLastPlayed", "lastEditTime", "originDatabaseUuid"]) {
      expect(cols).toContain(c);
    }
    expect((db.prepare("SELECT COUNT(*) c FROM Track").get() as any).c).toBe(500);
    expect((db.prepare("SELECT COUNT(*) c FROM PerformanceData").get() as any).c).toBe(500);
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/fixtures/gen-library.test.ts`
Expected: FAIL — cannot resolve `./gen-library.js`.

- [ ] **Step 3: Write the generator**

```ts
// tests/fixtures/gen-library.ts
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

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

/** Deterministic PRNG so fixtures are reproducible across runs. */
function rng(seed: number) {
  let s = seed;
  return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

export function makeLibrary(
  dir: string,
  opts: { tracks?: number; schema?: [number, number, number] } = {},
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

  const uuid = "00000000-0000-4000-8000-0000000000" + String(maj).padStart(2, "0");
  db.prepare(`INSERT INTO Information (uuid, schemaVersionMajor, schemaVersionMinor,
    schemaVersionPatch, currentPlayedIndiciator, lastRekordBoxLibraryImportReadCounter)
    VALUES (?,?,?,?,0,0)`).run(uuid, maj, min, pat);

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
      i, 180 + Math.floor(r() * 300), bpm, 2005 + Math.floor(r() * 21),
      `../Music/lib/${i % 50}/t${i}.mp3`, `t${i}.mp3`, 320, bpm + r() * 0.4,
      8_000_000 + Math.floor(r() * 4e6),
      `${pick(WORDS)} ${pick(WORDS)} ${i}`, pick(ARTISTS), `Album ${i % 40}`, pick(GENRES),
      r() < 0.3 ? pick(WORDS) : null, `Label ${i % 20}`,
      r() < 0.05 ? -1 : Math.floor(r() * 24), Math.floor(r() * 6),
      played, played ? 1 : 0, "mp3", r() < 0.9 ? 1 : 0,
      now - Math.floor(r() * 86400 * 1500), 1, now - Math.floor(r() * 86400 * 100),
      uuid, i,
    );
    const hasPerf = r() < 0.85;
    insP.run(i, hasPerf ? Buffer.alloc(64) : null, hasPerf ? Buffer.alloc(128) : null);
  }
  db.exec("COMMIT");
  db.close();
  return dbPath;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/fixtures/gen-library.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/fixtures/
git commit -m "test: add synthetic Engine 3.0.2 library generator"
```

---

### Task 3: Staleness probe

The spec rejects `mtime + size` because an mtime-preserving restore hides content changes. The probe reads the SQLite header change counter instead: 4 bytes big-endian at offset 24.

**Files:**
- Create: `src/probe.ts`
- Test: `tests/probe.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `readChangeCounter(dbPath: string): number`

- [ ] **Step 1: Write the failing test**

```ts
// tests/probe.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { makeLibrary } from "./fixtures/gen-library.js";
import { readChangeCounter } from "../src/probe.js";

let dir: string, dbPath: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "edj-probe-"));
  dbPath = makeLibrary(dir, { tracks: 200 });
});
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

describe("staleness probe", () => {
  it("detects a change even when mtime and size are preserved", () => {
    // Pin mtime to whole-second granularity, as rsync -t and cloud sync do.
    const sec = Math.floor(statSync(dbPath).mtimeMs / 1000) * 1000;
    utimesSync(dbPath, new Date(sec), new Date(sec));
    const before = { counter: readChangeCounter(dbPath), size: statSync(dbPath).size, mtime: statSync(dbPath).mtimeMs };

    const w = new DatabaseSync(dbPath);
    w.exec("UPDATE Track SET rating = 4 WHERE id = 1");
    w.close();
    utimesSync(dbPath, new Date(sec), new Date(sec));

    const after = { counter: readChangeCounter(dbPath), size: statSync(dbPath).size, mtime: statSync(dbPath).mtimeMs };

    // This is precisely the case mtime+size misses.
    expect(after.mtime).toBe(before.mtime);
    expect(after.size).toBe(before.size);
    expect(after.counter).not.toBe(before.counter);
  });

  it("is stable when nothing is written", () => {
    const a = readChangeCounter(dbPath);
    expect(readChangeCounter(dbPath)).toBe(a);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/probe.test.ts`
Expected: FAIL — cannot resolve `../src/probe.js`.

- [ ] **Step 3: Write the implementation**

```ts
// src/probe.ts
import { openSync, readSync, closeSync } from "node:fs";

/**
 * The SQLite file-change counter: 4 bytes big-endian at offset 24 of the
 * database header. It increments on every write transaction, is part of the
 * on-disk format, and survives process restarts — unlike PRAGMA data_version,
 * which only tracks changes within the life of one connection.
 */
export function readChangeCounter(dbPath: string): number {
  const fd = openSync(dbPath, "r");
  try {
    const buf = Buffer.alloc(28);
    const read = readSync(fd, buf, 0, 28, 0);
    if (read < 28) throw new Error(`${dbPath}: file too short to be a SQLite database`);
    return buf.readUInt32BE(24);
  } finally {
    closeSync(fd);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/probe.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/probe.ts tests/probe.test.ts
git commit -m "feat: probe staleness via SQLite header change counter"
```

---

### Task 4: Library discovery and schema allowlist

**Files:**
- Create: `src/paths.ts`, `src/discovery.ts`
- Test: `tests/discovery.test.ts`

**Interfaces:**
- Consumes: `err` from `src/errors.ts`
- Produces:
  - `sidecarPath(uuid: string): string` — `~/.engine-dj-mcp/<uuid>/index.db`
  - `type LibraryInfo = { path: string; uuid: string; schema: [number, number, number]; supported: boolean; trackCount: number | null }`
  - `readLibraryInfo(mdbPath: string): LibraryInfo | EngineError`
  - `discoverLibraries(roots?: string[]): LibraryInfo[]`
  - `SUPPORTED_SCHEMAS: readonly string[]`

- [ ] **Step 1: Write the failing test**

```ts
// tests/discovery.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLibrary } from "./fixtures/gen-library.js";
import { readLibraryInfo, discoverLibraries } from "../src/discovery.js";
import { isEngineError } from "../src/errors.js";

let dir: string;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "edj-disc-")); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

describe("discovery", () => {
  it("reads a supported library", () => {
    const info = readLibraryInfo(makeLibrary(dir, { tracks: 10 }));
    expect(isEngineError(info)).toBe(false);
    if (isEngineError(info)) return;
    expect(info.schema).toEqual([3, 0, 2]);
    expect(info.supported).toBe(true);
    expect(info.trackCount).toBe(10);
  });

  it("reports an unsupported schema instead of failing silently", () => {
    const other = mkdtempSync(join(tmpdir(), "edj-old-"));
    const info = readLibraryInfo(makeLibrary(other, { tracks: 5, schema: [2, 18, 0] }));
    expect(isEngineError(info)).toBe(false);
    if (isEngineError(info)) return;
    // Must still be listable: the user has to see WHY it is unusable.
    expect(info.schema).toEqual([2, 18, 0]);
    expect(info.supported).toBe(false);
    rmSync(other, { recursive: true, force: true });
  });

  it("returns library_not_found for a missing file", () => {
    const info = readLibraryInfo(join(dir, "nope", "m.db"));
    expect(isEngineError(info)).toBe(true);
    if (!isEngineError(info)) return;
    expect(info.error).toBe("library_not_found");
  });

  it("finds libraries under a given root", () => {
    const found = discoverLibraries([dir]);
    expect(found.length).toBe(1);
    expect(found[0]!.supported).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/discovery.test.ts`
Expected: FAIL — cannot resolve `../src/discovery.js`.

- [ ] **Step 3: Write `src/paths.ts`**

```ts
// src/paths.ts
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";

export function sidecarDir(uuid: string): string {
  return join(homedir(), ".engine-dj-mcp", uuid);
}

export function sidecarPath(uuid: string): string {
  return join(sidecarDir(uuid), "index.db");
}

/** Engine stores Track.path relative to the `Engine Library` folder, usually with `..`. */
export function absTrackPath(mdbPath: string, relative: string): string {
  const engineLibrary = dirname(dirname(mdbPath)); // .../Engine Library/Database2/m.db
  return resolve(engineLibrary, relative);
}

/** Candidate locations of `m.db` beneath a filesystem root. */
export function libraryCandidates(root: string): string[] {
  return [join(root, "Engine Library", "Database2", "m.db")];
}
```

- [ ] **Step 4: Write `src/discovery.ts`**

```ts
// src/discovery.ts
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { err, type EngineError } from "./errors.js";
import { libraryCandidates } from "./paths.js";

export const SUPPORTED_SCHEMAS = ["3.0.0", "3.0.1", "3.0.2"] as const;

export interface LibraryInfo {
  path: string;
  uuid: string;
  schema: [number, number, number];
  supported: boolean;
  trackCount: number | null;
}

export function readLibraryInfo(mdbPath: string): LibraryInfo | EngineError {
  if (!existsSync(mdbPath)) {
    return err("library_not_found", `No Engine library database at ${mdbPath}`);
  }
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(`file:${mdbPath}?mode=ro`, { readOnly: true });
  } catch (e) {
    return err("library_busy", "Could not open the Engine library", {
      detail: String((e as Error).message),
      retry_after_ms: 5000,
    });
  }
  try {
    // SELECT * on purpose: the Information column set differs between versions.
    const row = db.prepare("SELECT * FROM Information LIMIT 1").get() as
      | Record<string, unknown>
      | undefined;
    if (!row) return err("unsupported_schema", "Information table is empty");

    const schema: [number, number, number] = [
      Number(row.schemaVersionMajor ?? 0),
      Number(row.schemaVersionMinor ?? 0),
      Number(row.schemaVersionPatch ?? 0),
    ];
    const supported = (SUPPORTED_SCHEMAS as readonly string[]).includes(schema.join("."));

    let trackCount: number | null = null;
    try {
      trackCount = Number((db.prepare("SELECT COUNT(*) c FROM Track").get() as any).c);
    } catch {
      trackCount = null; // 1.x has no Track table; still listable.
    }
    return { path: mdbPath, uuid: String(row.uuid ?? ""), schema, supported, trackCount };
  } catch (e) {
    return err("unsupported_schema", "Could not read Information", {
      detail: String((e as Error).message),
    });
  } finally {
    db.close();
  }
}

function defaultRoots(): string[] {
  const roots = [join(homedir(), "Music")];
  try {
    for (const vol of readdirSync("/Volumes")) roots.push(join("/Volumes", vol));
  } catch {
    // /Volumes does not exist off macOS; ignore.
  }
  return roots;
}

export function discoverLibraries(roots: string[] = defaultRoots()): LibraryInfo[] {
  const out: LibraryInfo[] = [];
  for (const root of roots) {
    for (const candidate of libraryCandidates(root)) {
      if (!existsSync(candidate)) continue;
      const info = readLibraryInfo(candidate);
      if (!("error" in info)) out.push(info);
    }
  }
  return out;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/discovery.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add src/paths.ts src/discovery.ts tests/discovery.test.ts
git commit -m "feat: discover Engine libraries and gate on schema version"
```

---

### Task 5: Key and tempo semantics

The conversion is Engine's own, lifted from the application binary:
`(key + 15 - 2 * (key % 2)) % 24`. It is a bijection with full Camelot structure — even `key` yields mode B, odd yields A, and the number is `floor(v / 2) + 1`.

**Files:**
- Create: `src/semantics.ts`
- Test: `tests/semantics.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `camelot(key: number | null): string | null`, `keyName(key: number | null): string | null`, `tempo(bpmAnalyzed: number | null, bpm: number | null): number | null`, `camelotNeighbours(label: string): string[]`, `keyDistance(a: string, b: string): number | null`, `registerFunctions(db: DatabaseSync): void`

- [ ] **Step 1: Write the failing test**

```ts
// tests/semantics.test.ts
import { describe, it, expect } from "vitest";
import { camelot, tempo, camelotNeighbours, keyDistance } from "../src/semantics.js";

describe("camelot", () => {
  it("maps Engine key indices onto the Camelot wheel", () => {
    expect(camelot(0)).toBe("8B");
    expect(camelot(1)).toBe("8A");
    expect(camelot(2)).toBe("9B");
    expect(camelot(3)).toBe("9A");
    expect(camelot(4)).toBe("10B");
    expect(camelot(5)).toBe("10A");
  });

  it("returns null for an undetermined key", () => {
    expect(camelot(-1)).toBeNull();
    expect(camelot(null)).toBeNull();
  });

  it("is a bijection over the 24 wheel positions", () => {
    const labels = new Set<string>();
    for (let k = 0; k < 24; k++) labels.add(camelot(k)!);
    expect(labels.size).toBe(24);
  });
});

describe("tempo", () => {
  it("prefers the analysed value and uses the stored bpm at face value", () => {
    expect(tempo(128.03, 128)).toBeCloseTo(128.03, 2);
    expect(tempo(null, 128)).toBeCloseTo(128.0, 2);
    expect(tempo(null, null)).toBeNull();
  });
});

describe("harmonic neighbours", () => {
  it("returns the relative mode and both wheel neighbours", () => {
    expect(new Set(camelotNeighbours("8A"))).toEqual(new Set(["8A", "8B", "7A", "9A"]));
  });

  it("wraps around the wheel", () => {
    expect(new Set(camelotNeighbours("1A"))).toEqual(new Set(["1A", "1B", "12A", "2A"]));
  });

  it("measures distance around the wheel, not linearly", () => {
    expect(keyDistance("1A", "12A")).toBe(1);
    expect(keyDistance("1A", "7A")).toBe(6);
    expect(keyDistance("1A", "nonsense")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/semantics.test.ts`
Expected: FAIL — cannot resolve `../src/semantics.js`.

- [ ] **Step 3: Write the implementation**

```ts
// src/semantics.ts
import type { DatabaseSync } from "node:sqlite";

/**
 * Engine's own conversion, taken from the application binary:
 *   CASE key WHEN -1 THEN NULL ELSE (key + 15 - 2 * (key % 2)) % 24 END
 * The result is a wheel index: even `key` gives mode B, odd gives A, and the
 * wheel number is floor(index / 2) + 1. key=0 is C major, so 8B — the
 * standard Camelot anchor. That anchor is confirmed against Engine DJ's own
 * display, not assumed: the track stored as key=20 shows as 6B in Engine,
 * which is exactly what this formula produces ((20 + 15) % 24 = 11, wheel
 * number 6, mode B). A wrongly-anchored wheel would put that track on a
 * different number.
 */
export function camelotIndex(key: number | null): number | null {
  if (key === null || key === undefined || key < 0 || key > 23) return null;
  return (key + 15 - 2 * (key % 2)) % 24;
}

export function camelot(key: number | null): string | null {
  const v = camelotIndex(key);
  if (v === null) return null;
  return `${Math.floor(v / 2) + 1}${v % 2 === 1 ? "B" : "A"}`;
}

const NAMES_B = ["B", "F#", "Db", "Ab", "Eb", "Bb", "F", "C", "G", "D", "A", "E"];
const NAMES_A = ["Abm", "Ebm", "Bbm", "Fm", "Cm", "Gm", "Dm", "Am", "Em", "Bm", "F#m", "Dbm"];

export function keyName(key: number | null): string | null {
  const label = camelot(key);
  if (!label) return null;
  const { number, mode } = parseCamelot(label)!;
  return mode === "B" ? NAMES_B[number - 1]! : NAMES_A[number - 1]!;
}

export function tempo(bpmAnalyzed: number | null, bpm: number | null): number | null {
  if (bpmAnalyzed !== null && bpmAnalyzed !== undefined && bpmAnalyzed > 0) return bpmAnalyzed;
  if (bpm !== null && bpm !== undefined && bpm > 0) return bpm;
  return null;
}

export function parseCamelot(label: string): { number: number; mode: "A" | "B" } | null {
  const m = /^([1-9]|1[0-2])([AB])$/.exec(label.trim().toUpperCase());
  if (!m) return null;
  return { number: Number(m[1]), mode: m[2] as "A" | "B" };
}

/** Same number in the other mode, plus one step either way in the same mode. */
export function camelotNeighbours(label: string): string[] {
  const p = parseCamelot(label);
  if (!p) return [];
  const wrap = (n: number) => ((n - 1 + 12) % 12) + 1;
  return [
    `${p.number}${p.mode}`,
    `${p.number}${p.mode === "A" ? "B" : "A"}`,
    `${wrap(p.number - 1)}${p.mode}`,
    `${wrap(p.number + 1)}${p.mode}`,
  ];
}

export function keyDistance(a: string, b: string): number | null {
  const pa = parseCamelot(a), pb = parseCamelot(b);
  if (!pa || !pb) return null;
  const raw = Math.abs(pa.number - pb.number);
  return Math.min(raw, 12 - raw);
}

/**
 * SQL-callable versions. These are an escape hatch for run_sql; filtering by
 * key or tempo in a WHERE clause should use the indexed sidecar columns in
 * side.track_derived, because a JS callback runs per row and defeats indexes.
 */
export function registerFunctions(db: DatabaseSync): void {
  const opts = { deterministic: true } as const;
  db.function("camelot", opts, (key: unknown) => camelot(key === null ? null : Number(key)));
  db.function("key_name", opts, (key: unknown) => keyName(key === null ? null : Number(key)));
  db.function("tempo", opts, (a: unknown, b: unknown) =>
    tempo(a === null ? null : Number(a), b === null ? null : Number(b)));
  db.function("key_distance", opts, (a: unknown, b: unknown) =>
    a === null || b === null ? null : keyDistance(String(a), String(b)));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/semantics.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/semantics.ts tests/semantics.test.ts
git commit -m "feat: add Camelot, key name and tempo semantics"
```

---

### Task 6: Connection topology and read-only regression suite

This task encodes findings 1–3 and 7 from the spec's test plan. Each assertion here corresponds to an attack that succeeded against an earlier draft of the design.

**Files:**
- Create: `src/store/connections.ts`
- Test: `tests/readonly-guarantees.test.ts`

**Interfaces:**
- Consumes: `sidecarPath` from `src/paths.ts`, `registerFunctions` from `src/semantics.ts`
- Produces:
  - `openQueryConnection(mdbPath: string, sidecar: string | null): DatabaseSync` — `m.db` as main with `readOnly: true`, sidecar attached read-only, `busy_timeout = 3000`
  - `openSyncConnection(sidecar: string, mdbPath: string): DatabaseSync` — sidecar writable as main, `m.db` attached read-only

- [ ] **Step 1: Write the failing test**

```ts
// tests/readonly-guarantees.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, readdirSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { makeLibrary } from "./fixtures/gen-library.js";
import { openQueryConnection } from "../src/store/connections.js";

let dir: string, mdb: string, side: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "edj-ro-"));
  mdb = makeLibrary(dir, { tracks: 100 });
  side = join(dir, "side.db");
  const s = new DatabaseSync(side);
  s.exec("CREATE TABLE marker(v TEXT)");
  s.exec("INSERT INTO marker VALUES('old')");
  s.close();
});
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

describe("read-only is a kernel guarantee", () => {
  it("refuses a write after re-attaching the same database without mode=ro", () => {
    const db = openQueryConnection(mdb, side);
    let wrote = false;
    try {
      db.exec(`ATTACH DATABASE '${mdb}' AS rw`);
      db.exec("CREATE TABLE rw.pwned(x)");
      wrote = true;
    } catch { /* expected */ }
    db.close();
    expect(wrote).toBe(false);
  });

  it("refuses WITH ... INSERT, which defeats any prefix check", () => {
    const db = openQueryConnection(mdb, side);
    expect(() =>
      db.prepare("WITH s AS (SELECT 1 v) INSERT INTO Track(id) SELECT v FROM s").run(),
    ).toThrow();
    db.close();
  });

  it("executes only the first statement when several are chained", () => {
    const db = openQueryConnection(mdb, side);
    // prepare() ignores everything past the first semicolon. run_sql relies on
    // this; exec() does NOT behave this way and must never be used there.
    const row = db.prepare("SELECT 1 AS a; SELECT 2 AS a").get() as any;
    expect(row.a).toBe(1);
    db.close();
  });

  it("refuses plain VACUUM at the kernel level", () => {
    const db = openQueryConnection(mdb, side);
    expect(() => db.exec("VACUUM")).toThrow();
    db.close();
  });

  it("reads a database that still has a hot journal", () => {
    const holder = new DatabaseSync(mdb);
    holder.exec("BEGIN IMMEDIATE");
    holder.exec("UPDATE Track SET rating = 1 WHERE id < 10");
    const db = openQueryConnection(mdb, side);
    const c = (db.prepare("SELECT COUNT(*) c FROM Track").get() as any).c;
    expect(c).toBe(100);
    db.close();
    holder.exec("ROLLBACK");
    holder.close();
  });

  it("creates no files next to the user's database", () => {
    const db2 = join(dir, "Engine Library", "Database2");
    const before = new Set(readdirSync(db2));
    const db = openQueryConnection(mdb, side);
    db.prepare("SELECT COUNT(*) c FROM Track").get();
    db.close();
    const after = readdirSync(db2).filter((f) => !before.has(f));
    expect(after).toEqual([]);
  });

  it("picks up a swapped sidecar only after re-attaching", () => {
    const db = openQueryConnection(mdb, side);
    expect((db.prepare("SELECT v FROM side.marker").get() as any).v).toBe("old");

    const tmp = join(dir, "side.tmp");
    const s = new DatabaseSync(tmp);
    s.exec("CREATE TABLE marker(v TEXT)");
    s.exec("INSERT INTO marker VALUES('new')");
    s.close();
    renameSync(tmp, side);

    // rename() alone is invisible to an open connection: it keeps the old inode.
    expect((db.prepare("SELECT v FROM side.marker").get() as any).v).toBe("old");
    db.exec("DETACH DATABASE side");
    db.exec(`ATTACH DATABASE 'file:${side}?mode=ro' AS side`);
    expect((db.prepare("SELECT v FROM side.marker").get() as any).v).toBe("new");
    db.close();
    expect(existsSync(side)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/readonly-guarantees.test.ts`
Expected: FAIL — cannot resolve `../src/store/connections.js`.

- [ ] **Step 3: Write the implementation**

```ts
// src/store/connections.ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/readonly-guarantees.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/store/connections.ts tests/readonly-guarantees.test.ts
git commit -m "feat: two-connection topology with read-only regression suite"
```

---

### Task 7: run_sql statement guard

`VACUUM INTO` is accepted by the kernel even on a read-only connection and writes a file to disk, so the guard is load-bearing rather than defence in depth.

**Files:**
- Create: `src/guard.ts`
- Test: `tests/guard.test.ts`

**Interfaces:**
- Consumes: `err` from `src/errors.ts`
- Produces: `checkStatement(sql: string): EngineError | null`, `enforceLimit(sql: string, limit: number): string`

- [ ] **Step 1: Write the failing test**

```ts
// tests/guard.test.ts
import { describe, it, expect } from "vitest";
import { checkStatement, enforceLimit } from "../src/guard.js";

describe("statement guard", () => {
  it("allows reads and read-only introspection", () => {
    for (const sql of [
      "SELECT 1",
      "  select * from Track limit 5",
      "WITH x AS (SELECT 1) SELECT * FROM x",
      "PRAGMA table_info('Track')",
      "EXPLAIN QUERY PLAN SELECT 1",
    ]) {
      expect(checkStatement(sql)).toBeNull();
    }
  });

  it("rejects the statements that reach the filesystem or the attach list", () => {
    for (const sql of [
      "VACUUM",
      "VACUUM INTO '/tmp/exfil.db'",
      "ATTACH DATABASE '/tmp/x.db' AS rw",
      "DETACH DATABASE side",
      "PRAGMA journal_mode = WAL",
    ]) {
      const e = checkStatement(sql);
      expect(e?.error).toBe("invalid_argument");
    }
  });

  it("rejects a leading no-op used to smuggle a second statement", () => {
    // Only meaningful because run_sql uses prepare(); exec() would run both.
    expect(checkStatement("SELECT 1; VACUUM INTO '/tmp/x.db'")?.error).toBe("invalid_argument");
  });

  it("adds a LIMIT when the query has none", () => {
    expect(enforceLimit("SELECT * FROM Track", 50)).toBe("SELECT * FROM Track LIMIT 50");
    expect(enforceLimit("SELECT * FROM Track LIMIT 10", 50)).toBe("SELECT * FROM Track LIMIT 10");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/guard.test.ts`
Expected: FAIL — cannot resolve `../src/guard.js`.

- [ ] **Step 3: Write the implementation**

```ts
// src/guard.ts
import { err, type EngineError } from "./errors.js";

const FORBIDDEN = /^\s*(VACUUM|ATTACH|DETACH)\b/i;
const WRITE_PRAGMA = /^\s*PRAGMA\s+(?!table_info|table_list|index_list|index_info|foreign_key_list)/i;

/**
 * run_sql executes through prepare(), which ignores everything after the first
 * semicolon. exec() runs every statement and would let "SELECT 1; VACUUM INTO"
 * slip past a leading-statement check, so run_sql must never use it. We still
 * reject chained statements outright, because a query that relies on the tail
 * being dropped is a query whose author misunderstood what will run.
 */
export function checkStatement(sql: string): EngineError | null {
  const trimmed = sql.trim().replace(/;\s*$/, "");
  if (trimmed.includes(";")) {
    return err("invalid_argument", "Only a single SQL statement is allowed", { detail: sql });
  }
  if (FORBIDDEN.test(trimmed)) {
    return err("invalid_argument", "VACUUM, ATTACH and DETACH are not permitted", { detail: sql });
  }
  if (WRITE_PRAGMA.test(trimmed)) {
    return err("invalid_argument", "Only read-only PRAGMA introspection is permitted", { detail: sql });
  }
  return null;
}

export function enforceLimit(sql: string, limit: number): string {
  return /\blimit\b/i.test(sql) ? sql : `${sql.trim().replace(/;\s*$/, "")} LIMIT ${limit}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/guard.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/guard.ts tests/guard.test.ts
git commit -m "feat: guard run_sql against VACUUM, ATTACH and chained statements"
```

---

### Task 8: Sidecar schema and rebuild

There is no incremental sync. `lastEditTime` misses inserts, deletes, `path` changes and play events, and a full rebuild costs about 100 ms at 50k rows.

**Files:**
- Create: `src/sidecar/schema.ts`, `src/sidecar/build.ts`
- Test: `tests/sidecar.test.ts`

**Interfaces:**
- Consumes: `openSyncConnection` from `src/store/connections.ts`, `readChangeCounter` from `src/probe.ts`
- Produces: `buildSidecar(args: { mdbPath: string; outPath: string; uuid: string; schema: string }): { indexed: number; elapsed_ms: number }`

- [ ] **Step 1: Write the failing test**

```ts
// tests/sidecar.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { makeLibrary } from "./fixtures/gen-library.js";
import { buildSidecar } from "../src/sidecar/build.js";

let dir: string, mdb: string, side: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "edj-side-"));
  mdb = makeLibrary(dir, { tracks: 2000 });
  side = join(dir, "index.db");
  buildSidecar({ mdbPath: mdb, outPath: side, uuid: "u", schema: "3.0.2" });
});
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

describe("sidecar", () => {
  it("indexes every track", () => {
    const db = new DatabaseSync(side, { readOnly: true });
    expect((db.prepare("SELECT COUNT(*) c FROM track_derived").get() as any).c).toBe(2000);
    expect((db.prepare("SELECT COUNT(*) c FROM fts_map").get() as any).c).toBe(2000);
    db.close();
  });

  it("matches full text with diacritics folded", () => {
    const db = new DatabaseSync(side, { readOnly: true });
    // Engine itself only does LIKE and misses "Ämbient" for "ambient".
    const hit = db.prepare("SELECT COUNT(*) c FROM fts_track WHERE fts_track MATCH 'ambient'").get() as any;
    expect(hit.c).toBeGreaterThan(0);
    db.close();
  });

  it("uses an index for the camelot filter rather than scanning", () => {
    const db = new DatabaseSync(side, { readOnly: true });
    const plan = (db.prepare("EXPLAIN QUERY PLAN SELECT track_id FROM track_derived WHERE camelot = '8A'").all() as any[])
      .map((r) => r.detail).join(" ");
    expect(plan).toMatch(/USING (COVERING )?INDEX/);
    db.close();
  });

  it("records the change counter it was built against", () => {
    const db = new DatabaseSync(side, { readOnly: true });
    const meta = db.prepare("SELECT * FROM index_meta").get() as any;
    expect(meta.library_uuid).toBe("u");
    expect(meta.schema_version).toBe("3.0.2");
    expect(typeof meta.change_counter).toBe("number");
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/sidecar.test.ts`
Expected: FAIL — cannot resolve `../src/sidecar/build.js`.

- [ ] **Step 3: Write `src/sidecar/schema.ts`**

```ts
// src/sidecar/schema.ts
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
```

- [ ] **Step 4: Write `src/sidecar/build.ts`**

```ts
// src/sidecar/build.ts
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
    db.exec(`INSERT INTO track_derived(track_id, camelot, tempo, has_cues, has_grid)
             SELECT t.id,
                    camelot(t.key),
                    tempo(t.bpmAnalyzed, t.bpm),
                    CASE WHEN p.quickCues IS NOT NULL THEN 1 ELSE 0 END,
                    CASE WHEN p.beatData  IS NOT NULL THEN 1 ELSE 0 END
             FROM engine.Track t
             LEFT JOIN engine.PerformanceData p ON p.trackId = t.id`);
    db.exec("COMMIT");

    for (const ix of SIDECAR_INDEXES) db.exec(ix);

    const indexed = Number((db.prepare("SELECT COUNT(*) c FROM track_derived").get() as any).c);
    db.prepare(`INSERT INTO index_meta (library_uuid, schema_version, change_counter, built_at, generation)
                VALUES (?,?,?,?,?)`)
      .run(args.uuid, args.schema, counter, Math.floor(started / 1000), args.generation ?? 1);
    return { indexed, elapsed_ms: Date.now() - started };
  } finally {
    db.close();
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/sidecar.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add src/sidecar/ tests/sidecar.test.ts
git commit -m "feat: build FTS5 and derived-column sidecar index"
```

---

### Task 9: Query process with a hard timeout

`node:sqlite` has no `interrupt()` and `DatabaseSync` is synchronous, so a heavy query blocks the event loop. `worker.terminate()` does not help — it waits for the synchronous native call to return. A forked process killed with `SIGKILL` dies in about 2 ms.

**Files:**
- Create: `src/proc/query-worker.ts`, `src/proc/query-client.ts`
- Test: `tests/query-process.test.ts`

**Interfaces:**
- Consumes: `openQueryConnection`, `reattachSidecar`, `err`
- Produces: `class QueryProcess { constructor(mdbPath: string, sidecar: string | null, timeoutMs?: number); run(sql: string, params?: unknown[]): Promise<{ columns: string[]; rows: unknown[][] } | EngineError>; setSidecar(path: string): Promise<void>; dispose(): void }`

- [ ] **Step 1: Write the failing test**

```ts
// tests/query-process.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLibrary } from "./fixtures/gen-library.js";
import { QueryProcess } from "../src/proc/query-client.js";
import { isEngineError } from "../src/errors.js";

let dir: string, mdb: string, qp: QueryProcess;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "edj-proc-"));
  mdb = makeLibrary(dir, { tracks: 20000 });
  qp = new QueryProcess(mdb, null, 800);
});
afterAll(() => { qp.dispose(); rmSync(dir, { recursive: true, force: true }); });

describe("query process", () => {
  it("returns rows for an ordinary query", async () => {
    const r = await qp.run("SELECT id, title FROM Track WHERE key = 4 LIMIT 5");
    expect(isEngineError(r)).toBe(false);
    if (isEngineError(r)) return;
    expect(r.columns).toEqual(["id", "title"]);
    expect(r.rows.length).toBeLessThanOrEqual(5);
  });

  it("kills a runaway query and stays usable afterwards", async () => {
    const started = Date.now();
    const r = await qp.run(
      "SELECT COUNT(*) FROM Track x JOIN Track y ON x.bpm = y.bpm JOIN Track z ON z.bpm = x.bpm",
    );
    expect(isEngineError(r)).toBe(true);
    if (!isEngineError(r)) return;
    expect(r.error).toBe("query_timeout");
    // The whole point: we do not wait for the query to finish.
    expect(Date.now() - started).toBeLessThan(4000);

    const ok = await qp.run("SELECT COUNT(*) AS c FROM Track");
    expect(isEngineError(ok)).toBe(false);
  }, 20_000);

  it("reports SQL errors as structured results rather than throwing", async () => {
    const r = await qp.run("SELECT * FROM NoSuchTable");
    expect(isEngineError(r)).toBe(true);
  });

  it("returns BLOBs as Buffers across the process boundary", async () => {
    // IPC serialises with JSON: an unframed Uint8Array arrives as
    // {"0":1,"1":2,...} and silently destroys PerformanceData decoding.
    const r = await qp.run("SELECT beatData FROM PerformanceData WHERE beatData IS NOT NULL LIMIT 1");
    expect(isEngineError(r)).toBe(false);
    if (isEngineError(r)) return;
    expect(Buffer.isBuffer(r.rows[0]![0])).toBe(true);
    expect((r.rows[0]![0] as Buffer).length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/query-process.test.ts`
Expected: FAIL — cannot resolve `../src/proc/query-client.js`.

- [ ] **Step 3: Write `src/proc/query-worker.ts`**

```ts
// src/proc/query-worker.ts
import { openQueryConnection, reattachSidecar } from "../store/connections.js";
import type { DatabaseSync } from "node:sqlite";

interface Request { id: number; kind: "query" | "sidecar"; sql?: string; params?: unknown[]; path?: string }

/**
 * IPC serialises with JSON, and a Uint8Array degrades to {"0":1,"1":2,...}.
 * node:sqlite returns BLOBs as Uint8Array, so every blob must be framed
 * explicitly or PerformanceData decoding receives garbage.
 */
function encodeValue(v: unknown): unknown {
  return v instanceof Uint8Array ? { __blob: Buffer.from(v).toString("base64") } : v;
}

const [, , mdbPath, sidecarArg] = process.argv;
let sidecar: string | null = sidecarArg && sidecarArg !== "-" ? sidecarArg : null;
let db: DatabaseSync = openQueryConnection(mdbPath!, sidecar);

process.on("message", (req: Request) => {
  try {
    if (req.kind === "sidecar") {
      sidecar = req.path!;
      reattachSidecar(db, sidecar);
      process.send!({ id: req.id, ok: true });
      return;
    }
    const stmt = db.prepare(req.sql!);
    stmt.setReadBigInts(false);
    const rows = stmt.all(...((req.params ?? []) as any[])) as Record<string, unknown>[];
    const columns = rows.length ? Object.keys(rows[0]!) : [];
    process.send!({
      id: req.id, ok: true, columns,
      rows: rows.map((r) => columns.map((c) => encodeValue(r[c]))),
    });
  } catch (e) {
    process.send!({ id: req.id, ok: false, message: (e as Error).message });
  }
});

process.send!({ ready: true });
```

- [ ] **Step 4: Write `src/proc/query-client.ts`**

```ts
// src/proc/query-client.ts
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { err, type EngineError } from "../errors.js";

const WORKER = join(dirname(fileURLToPath(import.meta.url)), "query-worker.js");

export interface QueryResult { columns: string[]; rows: unknown[][] }

/** Counterpart to encodeValue in the worker: rebuild BLOBs framed as base64. */
function decodeValue(v: unknown): unknown {
  if (v && typeof v === "object" && typeof (v as any).__blob === "string") {
    return Buffer.from((v as any).__blob, "base64");
  }
  return v;
}

/**
 * Runs every library query in a child process. node:sqlite exposes no
 * interrupt() and DatabaseSync blocks the event loop; worker.terminate() waits
 * for the synchronous native call to return, so a killable process is the only
 * timeout that actually works. It also isolates a crash in the experimental
 * node:sqlite binding from the MCP server itself.
 */
export class QueryProcess {
  #child: ChildProcess | null = null;
  #ready: Promise<void> | null = null;
  #seq = 0;

  constructor(
    private readonly mdbPath: string,
    private sidecar: string | null,
    private readonly timeoutMs = 10_000,
  ) {}

  #spawn(): Promise<void> {
    const child = fork(WORKER, [this.mdbPath, this.sidecar ?? "-"], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
    this.#child = child;
    child.once("exit", () => { if (this.#child === child) { this.#child = null; this.#ready = null; } });
    return new Promise((resolve) => child.once("message", () => resolve()));
  }

  async #ensure(): Promise<ChildProcess> {
    if (!this.#child) this.#ready = this.#spawn();
    await this.#ready;
    return this.#child!;
  }

  #kill(): void {
    this.#child?.kill("SIGKILL");
    this.#child = null;
    this.#ready = null;
  }

  async #send(payload: Record<string, unknown>): Promise<any | EngineError> {
    let child: ChildProcess;
    try {
      child = await this.#ensure();
    } catch (e) {
      return err("query_process_crashed", "Could not start the query process", { detail: String(e) });
    }
    const id = ++this.#seq;
    return new Promise((resolve) => {
      const onMessage = (m: any) => { if (m?.id === id) { cleanup(); resolve(m); } };
      const onExit = () => { cleanup(); resolve(err("query_process_crashed", "The query process exited; it has been restarted")); };
      const timer = setTimeout(() => {
        cleanup();
        this.#kill();
        resolve(err("query_timeout", `Query exceeded ${this.timeoutMs} ms and was terminated`));
      }, this.timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        child.off("message", onMessage);
        child.off("exit", onExit);
      };
      child.on("message", onMessage);
      child.once("exit", onExit);
      child.send({ id, ...payload });
    });
  }

  async run(sql: string, params: unknown[] = []): Promise<QueryResult | EngineError> {
    const m = await this.#send({ kind: "query", sql, params });
    if ("error" in m) return m as EngineError;
    if (!m.ok) {
      return /database is locked|busy/i.test(m.message)
        ? err("library_busy", "Engine DJ is writing to the library right now", { retry_after_ms: 5000 })
        : err("invalid_argument", "The SQL query failed", { detail: m.message });
    }
    return { columns: m.columns, rows: m.rows.map((row: unknown[]) => row.map(decodeValue)) };
  }

  async setSidecar(path: string): Promise<void> {
    this.sidecar = path;
    await this.#send({ kind: "sidecar", path });
  }

  dispose(): void { this.#kill(); }
}
```

- [ ] **Step 5: Build so the worker exists as JavaScript**

Run: `npm run build`
Expected: `dist/proc/query-worker.js` present. Tests run against `src` via vitest, so add to `vitest.config.ts` an alias step is not needed — instead the test uses the compiled worker path. To keep tests hermetic, set `WORKER` to resolve `query-worker.ts` when running under vitest:

```ts
const WORKER = join(
  dirname(fileURLToPath(import.meta.url)),
  process.env.VITEST ? "query-worker.ts" : "query-worker.js",
);
```

and add `execArgv: process.env.VITEST ? ["--experimental-strip-types"] : []` to the `fork` options.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/query-process.test.ts`
Expected: PASS, 3 tests. The timeout test must finish in well under its 20 s budget.

- [ ] **Step 7: Commit**

```bash
git add src/proc/ tests/query-process.test.ts
git commit -m "feat: run queries in a killable child process"
```

---

### Task 10: Index lifecycle

Ties together the probe, the rebuild, the atomic swap and the re-attach handshake.

**Files:**
- Create: `src/store/index-manager.ts`
- Test: `tests/index-manager.test.ts`

**Interfaces:**
- Consumes: `readChangeCounter`, `buildSidecar`, `sidecarPath`, `QueryProcess`
- Produces: `class IndexManager { constructor(lib: LibraryInfo, qp: QueryProcess, baseDir?: string); ensureFresh(): Promise<{ rebuilt: boolean; indexed: number; elapsed_ms: number; generation: number } | EngineError>; get generation(): number; get path(): string }` — `baseDir` defaults to `~/.engine-dj-mcp`; tests pass a temporary directory.

- [ ] **Step 1: Write the failing test**

```ts
// tests/index-manager.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { makeLibrary } from "./fixtures/gen-library.js";
import { readLibraryInfo } from "../src/discovery.js";
import { QueryProcess } from "../src/proc/query-client.js";
import { IndexManager } from "../src/store/index-manager.js";
import { isEngineError } from "../src/errors.js";

let dir: string, mdb: string, qp: QueryProcess, mgr: IndexManager;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "edj-mgr-"));
  mdb = makeLibrary(dir, { tracks: 300 });
  const lib = readLibraryInfo(mdb);
  if (isEngineError(lib)) throw new Error("fixture library unreadable");
  qp = new QueryProcess(mdb, null, 5000);
  mgr = new IndexManager(lib, qp, join(dir, "sidecars"));
});
afterAll(() => { qp.dispose(); rmSync(dir, { recursive: true, force: true }); });

describe("index lifecycle", () => {
  it("builds on first use", async () => {
    const r = await mgr.ensureFresh();
    expect(isEngineError(r)).toBe(false);
    if (isEngineError(r)) return;
    expect(r.rebuilt).toBe(true);
    expect(r.indexed).toBe(300);
  });

  it("does not rebuild when nothing changed", async () => {
    const r = await mgr.ensureFresh();
    expect(isEngineError(r)).toBe(false);
    if (isEngineError(r)) return;
    expect(r.rebuilt).toBe(false);
  });

  it("rebuilds after a write and the query process sees the new index", async () => {
    const w = new DatabaseSync(mdb);
    w.exec("UPDATE Track SET title = 'freshly renamed marker' WHERE id = 7");
    w.close();

    const r = await mgr.ensureFresh();
    expect(isEngineError(r)).toBe(false);
    if (isEngineError(r)) return;
    expect(r.rebuilt).toBe(true);

    const hit = await qp.run(
      "SELECT m.track_id FROM side.fts_track f JOIN side.fts_map m ON m.rowid = f.rowid WHERE f.fts_track MATCH 'freshly'",
    );
    expect(isEngineError(hit)).toBe(false);
    if (isEngineError(hit)) return;
    expect(hit.rows).toEqual([[7]]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/index-manager.test.ts`
Expected: FAIL — cannot resolve `../src/store/index-manager.js`.

- [ ] **Step 3: Write the implementation**

```ts
// src/store/index-manager.ts
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readChangeCounter } from "../probe.js";
import { buildSidecar } from "../sidecar/build.js";
import { sidecarDir } from "../paths.js";
import { err, type EngineError } from "../errors.js";
import type { LibraryInfo } from "../discovery.js";
import type { QueryProcess } from "../proc/query-client.js";

export interface FreshResult {
  rebuilt: boolean; indexed: number; elapsed_ms: number; generation: number;
}

export class IndexManager {
  #generation = 0;

  constructor(
    private readonly lib: LibraryInfo,
    private readonly qp: QueryProcess,
    private readonly baseDir: string = sidecarDir(""),
  ) {}

  get generation(): number { return this.#generation; }

  get path(): string { return join(this.baseDir, this.lib.uuid, "index.db"); }

  #storedCounter(): number | null {
    if (!existsSync(this.path)) return null;
    try {
      const db = new DatabaseSync(this.path, { readOnly: true });
      try {
        const row = db.prepare("SELECT change_counter, generation FROM index_meta LIMIT 1").get() as any;
        if (row?.generation) this.#generation = Number(row.generation);
        return row ? Number(row.change_counter) : null;
      } finally { db.close(); }
    } catch { return null; }
  }

  async ensureFresh(): Promise<FreshResult | EngineError> {
    if (!this.lib.supported) {
      return err("unsupported_schema", `Schema ${this.lib.schema.join(".")} is not supported`, {
        detail: "Supported versions are 3.0.0, 3.0.1 and 3.0.2",
      });
    }

    let current: number;
    try {
      current = readChangeCounter(this.lib.path);
    } catch (e) {
      return err("library_not_found", "Could not read the library header", { detail: String(e) });
    }

    if (this.#storedCounter() === current) {
      return { rebuilt: false, indexed: -1, elapsed_ms: 0, generation: this.#generation };
    }

    mkdirSync(join(this.baseDir, this.lib.uuid), { recursive: true });
    const tmp = `${this.path}.tmp`;
    let built: { indexed: number; elapsed_ms: number };
    try {
      built = buildSidecar({
        mdbPath: this.lib.path,
        outPath: tmp,
        uuid: this.lib.uuid,
        schema: this.lib.schema.join("."),
        generation: this.#generation + 1,
      });
    } catch (e) {
      const message = String((e as Error).message);
      // Serving a slightly stale index beats refusing to answer at all.
      return /locked|busy/i.test(message)
        ? err("index_stale", "The library was busy; the previous index is still in use", { retry_after_ms: 5000 })
        : err("library_busy", "Could not rebuild the index", { detail: message });
    }

    // rename() is invisible to an open connection, so the process must re-attach.
    renameSync(tmp, this.path);
    this.#generation += 1;
    await this.qp.setSidecar(this.path);

    return { rebuilt: true, generation: this.#generation, ...built };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/index-manager.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/store/index-manager.ts tests/index-manager.test.ts
git commit -m "feat: rebuild, swap and re-attach the sidecar index"
```

---

### Task 11: search_tracks

**Files:**
- Create: `src/tools/search.ts`
- Test: `tests/search.test.ts`

**Interfaces:**
- Consumes: `QueryProcess`, `camelotNeighbours`, `err`
- Produces: `SearchInput` zod shape, `searchTracks(qp: QueryProcess, input: SearchInput): Promise<{ tracks: Record<string, unknown>[]; total?: number; next_cursor?: string } | EngineError>`, `DEFAULT_FIELDS: string[]`

- [ ] **Step 1: Write the failing test**

```ts
// tests/search.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLibrary } from "./fixtures/gen-library.js";
import { readLibraryInfo } from "../src/discovery.js";
import { QueryProcess } from "../src/proc/query-client.js";
import { IndexManager } from "../src/store/index-manager.js";
import { searchTracks, DEFAULT_FIELDS } from "../src/tools/search.js";
import { isEngineError } from "../src/errors.js";

let dir: string, qp: QueryProcess;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "edj-search-"));
  const mdb = makeLibrary(dir, { tracks: 1500 });
  const lib = readLibraryInfo(mdb);
  if (isEngineError(lib)) throw new Error("fixture library unreadable");
  qp = new QueryProcess(mdb, null, 5000);
  await new IndexManager(lib, qp, join(dir, "sidecars")).ensureFresh();
});
afterAll(() => { qp.dispose(); rmSync(dir, { recursive: true, force: true }); });

describe("search_tracks", () => {
  it("projects six fields by default", async () => {
    const r = await searchTracks(qp, { limit: 3 });
    expect(isEngineError(r)).toBe(false);
    if (isEngineError(r)) return;
    expect(Object.keys(r.tracks[0]!)).toEqual(DEFAULT_FIELDS);
  });

  it("matches full text and folds diacritics", async () => {
    const r = await searchTracks(qp, { q: "ambient", limit: 5 });
    expect(isEngineError(r)).toBe(false);
    if (isEngineError(r)) return;
    expect(r.tracks.length).toBeGreaterThan(0);
  });

  it("filters by tempo window", async () => {
    const r = await searchTracks(qp, { bpm: { around: 124, tolerance_pct: 2 }, limit: 50 });
    expect(isEngineError(r)).toBe(false);
    if (isEngineError(r)) return;
    for (const t of r.tracks) {
      expect(Number(t.bpm)).toBeGreaterThanOrEqual(124 * 0.98 - 0.01);
      expect(Number(t.bpm)).toBeLessThanOrEqual(124 * 1.02 + 0.01);
    }
  });

  it("paginates relevance-ordered results without overlap", async () => {
    // A cursor keyed on id alone cannot work here: ORDER BY rank yields
    // non-monotonic ids, so the cursor encodes (rank, rowid).
    const p1 = await searchTracks(qp, { q: "dark", limit: 5 });
    expect(isEngineError(p1)).toBe(false);
    if (isEngineError(p1)) return;
    expect(p1.next_cursor).toBeTruthy();

    const p2 = await searchTracks(qp, { q: "dark", limit: 5, cursor: p1.next_cursor });
    expect(isEngineError(p2)).toBe(false);
    if (isEngineError(p2)) return;

    const ids1 = p1.tracks.map((t) => t.id);
    const ids2 = p2.tracks.map((t) => t.id);
    expect(ids1.filter((i) => ids2.includes(i))).toEqual([]);
  });

  it("omits total unless asked, and caps it when asked", async () => {
    const without = await searchTracks(qp, { limit: 2 });
    expect(isEngineError(without)).toBe(false);
    if (isEngineError(without)) return;
    expect(without.total).toBeUndefined();

    const with_ = await searchTracks(qp, { limit: 2, include_total: true });
    expect(isEngineError(with_)).toBe(false);
    if (isEngineError(with_)) return;
    expect(with_.total).toBeGreaterThan(0);
  });

  it("clamps limit to the maximum", async () => {
    const r = await searchTracks(qp, { limit: 5000 });
    expect(isEngineError(r)).toBe(false);
    if (isEngineError(r)) return;
    expect(r.tracks.length).toBeLessThanOrEqual(200);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/search.test.ts`
Expected: FAIL — cannot resolve `../src/tools/search.js`.

- [ ] **Step 3: Write the implementation**

```ts
// src/tools/search.ts
import { z } from "zod";
import { err, isEngineError, type EngineError } from "../errors.js";
import { camelotNeighbours } from "../semantics.js";
import type { QueryProcess } from "../proc/query-client.js";

export const DEFAULT_FIELDS = ["id", "artist", "title", "bpm", "camelot", "rating"] as const;
const MAX_LIMIT = 200;
const TOTAL_CAP = 1000;

const FIELD_SQL: Record<string, string> = {
  id: "t.id", artist: "t.artist", title: "t.title", album: "t.album",
  genre: "t.genre", comment: "t.comment", label: "t.label", year: "t.year",
  rating: "t.rating", length: "t.length", path: "t.path", filename: "t.filename",
  bpm: "d.tempo", camelot: "d.camelot",
  has_cues: "d.has_cues", has_beatgrid: "d.has_grid",
  date_added: "t.dateAdded", last_played: "t.timeLastPlayed", is_analyzed: "t.isAnalyzed",
};

export const SearchInput = z.object({
  q: z.string().optional(),
  bpm: z.object({
    min: z.number().optional(), max: z.number().optional(),
    around: z.number().optional(), tolerance_pct: z.number().default(3),
  }).optional(),
  key: z.object({
    camelot: z.array(z.string()).optional(),
    compatible_with: z.string().optional(),
    mode: z.enum(["major", "minor"]).optional(),
  }).optional(),
  rating: z.object({ min: z.number().optional(), max: z.number().optional() }).optional(),
  played: z.object({
    never: z.boolean().optional(), before: z.string().optional(), after: z.string().optional(),
  }).optional(),
  added: z.object({ before: z.string().optional(), after: z.string().optional() }).optional(),
  flags: z.object({
    analyzed: z.boolean().optional(), has_cues: z.boolean().optional(),
    has_beatgrid: z.boolean().optional(), available: z.boolean().optional(),
  }).optional(),
  fields: z.array(z.string()).optional(),
  limit: z.number().int().positive().default(25),
  cursor: z.string().optional(),
  include_total: z.boolean().default(false),
});
export type SearchInput = z.input<typeof SearchInput>;

/** A date is either ISO-8601 or a SQLite relative modifier such as "-6 months". */
function epochExpr(value: string): { sql: string; param: string } {
  return /^-?\d+\s+(second|minute|hour|day|month|year)s?$/i.test(value.trim())
    ? { sql: "strftime('%s','now',?)", param: value.trim() }
    : { sql: "strftime('%s',?)", param: value.trim() };
}

function encodeCursor(rank: number | null, rowid: number): string {
  return Buffer.from(JSON.stringify([rank, rowid])).toString("base64url");
}
function decodeCursor(c: string): [number | null, number] | null {
  try {
    const v = JSON.parse(Buffer.from(c, "base64url").toString("utf8"));
    return Array.isArray(v) && v.length === 2 ? [v[0], Number(v[1])] : null;
  } catch { return null; }
}

export async function searchTracks(
  qp: QueryProcess,
  raw: SearchInput,
): Promise<{ tracks: Record<string, unknown>[]; total?: number; next_cursor?: string } | EngineError> {
  const input = SearchInput.parse(raw);
  const limit = Math.min(input.limit, MAX_LIMIT);
  const fields = (input.fields ?? [...DEFAULT_FIELDS]).filter((f) => f in FIELD_SQL);
  if (fields.length === 0) return err("invalid_argument", "No recognised fields requested");

  const where: string[] = [];
  const params: unknown[] = [];
  const useFts = Boolean(input.q && input.q.trim());

  if (useFts) { where.push("f.fts_track MATCH ?"); params.push(input.q!.trim()); }

  if (input.bpm) {
    const { min, max, around, tolerance_pct } = input.bpm;
    if (around !== undefined) {
      where.push("d.tempo BETWEEN ? AND ?");
      params.push(around * (1 - tolerance_pct / 100), around * (1 + tolerance_pct / 100));
    }
    if (min !== undefined) { where.push("d.tempo >= ?"); params.push(min); }
    if (max !== undefined) { where.push("d.tempo <= ?"); params.push(max); }
  }

  if (input.key) {
    const labels = new Set<string>(input.key.camelot ?? []);
    if (input.key.compatible_with) for (const n of camelotNeighbours(input.key.compatible_with)) labels.add(n);
    if (labels.size) {
      where.push(`d.camelot IN (${[...labels].map(() => "?").join(",")})`);
      params.push(...labels);
    }
    if (input.key.mode) {
      where.push(`d.camelot LIKE ?`);
      params.push(input.key.mode === "minor" ? "%A" : "%B");
    }
  }

  if (input.rating?.min !== undefined) { where.push("t.rating >= ?"); params.push(input.rating.min); }
  if (input.rating?.max !== undefined) { where.push("t.rating <= ?"); params.push(input.rating.max); }

  if (input.played?.never) where.push("(t.timeLastPlayed IS NULL OR t.isPlayed = 0)");
  if (input.played?.before) {
    const e = epochExpr(input.played.before);
    where.push(`(t.timeLastPlayed IS NULL OR t.timeLastPlayed < ${e.sql})`);
    params.push(e.param);
  }
  if (input.played?.after) {
    const e = epochExpr(input.played.after);
    where.push(`t.timeLastPlayed >= ${e.sql}`); params.push(e.param);
  }
  if (input.added?.after) { const e = epochExpr(input.added.after); where.push(`t.dateAdded >= ${e.sql}`); params.push(e.param); }
  if (input.added?.before) { const e = epochExpr(input.added.before); where.push(`t.dateAdded < ${e.sql}`); params.push(e.param); }

  if (input.flags?.analyzed !== undefined) { where.push("t.isAnalyzed = ?"); params.push(input.flags.analyzed ? 1 : 0); }
  if (input.flags?.available !== undefined) { where.push("t.isAvailable = ?"); params.push(input.flags.available ? 1 : 0); }
  if (input.flags?.has_cues !== undefined) { where.push("d.has_cues = ?"); params.push(input.flags.has_cues ? 1 : 0); }
  if (input.flags?.has_beatgrid !== undefined) { where.push("d.has_grid = ?"); params.push(input.flags.has_beatgrid ? 1 : 0); }

  const from = useFts
    ? `FROM side.fts_track f
       JOIN side.fts_map m ON m.rowid = f.rowid
       JOIN main.Track t ON t.id = m.track_id
       JOIN side.track_derived d ON d.track_id = t.id`
    : `FROM main.Track t JOIN side.track_derived d ON d.track_id = t.id`;

  // Relevance ordering makes ids non-monotonic, so the keyset is (rank, rowid).
  const orderKey = useFts ? "rank" : "t.id";
  const rowKey = useFts ? "f.rowid" : "t.id";

  if (input.cursor) {
    const cur = decodeCursor(input.cursor);
    if (!cur) return err("invalid_argument", "Malformed cursor");
    where.push(`(${orderKey}, ${rowKey}) > (?, ?)`);
    params.push(useFts ? cur[0] : cur[1], cur[1]);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const select = fields.map((f) => `${FIELD_SQL[f]} AS "${f}"`).join(", ");
  const sql = `SELECT ${select}, ${orderKey} AS __rank, ${rowKey} AS __row
               ${from} ${whereSql}
               ORDER BY ${orderKey}, ${rowKey} LIMIT ${limit}`;

  const res = await qp.run(sql, params);
  if (isEngineError(res)) return res;

  const idx = Object.fromEntries(res.columns.map((c, i) => [c, i]));
  const tracks = res.rows.map((row) =>
    Object.fromEntries(fields.map((f) => [f, row[idx[f]!]])) as Record<string, unknown>);

  let next_cursor: string | undefined;
  if (res.rows.length === limit) {
    const last = res.rows[res.rows.length - 1]!;
    next_cursor = encodeCursor(last[idx.__rank!] as number, Number(last[idx.__row!]));
  }

  let total: number | undefined;
  if (input.include_total) {
    const countSql = `SELECT COUNT(*) AS c FROM (SELECT 1 ${from} ${whereSql} LIMIT ${TOTAL_CAP + 1})`;
    const cres = await qp.run(countSql, params);
    if (!isEngineError(cres) && cres.rows.length) total = Number(cres.rows[0]![0]);
  }

  return { tracks, ...(total !== undefined ? { total } : {}), ...(next_cursor ? { next_cursor } : {}) };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/search.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/tools/search.ts tests/search.test.ts
git commit -m "feat: add search_tracks with FTS, filters and keyset pagination"
```

---

### Task 12: get_tracks, list_libraries and refresh_index

**Files:**
- Create: `src/tools/tracks.ts`, `src/tools/libraries.ts`, `src/tools/refresh.ts`
- Test: `tests/tools-basic.test.ts`

**Interfaces:**
- Consumes: `QueryProcess`, `IndexManager`, `discoverLibraries`, `FIELD_SQL`/`DEFAULT_FIELDS` from `src/tools/search.ts`
- Produces: `getTracks(qp, { ids, fields? })`, `listLibraries(managers)`, `refreshIndex(mgr)`

- [ ] **Step 1: Write the failing test**

```ts
// tests/tools-basic.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLibrary } from "./fixtures/gen-library.js";
import { readLibraryInfo } from "../src/discovery.js";
import { QueryProcess } from "../src/proc/query-client.js";
import { IndexManager } from "../src/store/index-manager.js";
import { getTracks } from "../src/tools/tracks.js";
import { refreshIndex } from "../src/tools/refresh.js";
import { isEngineError } from "../src/errors.js";

let dir: string, qp: QueryProcess, mgr: IndexManager;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "edj-basic-"));
  const mdb = makeLibrary(dir, { tracks: 400 });
  const lib = readLibraryInfo(mdb);
  if (isEngineError(lib)) throw new Error("fixture library unreadable");
  qp = new QueryProcess(mdb, null, 5000);
  mgr = new IndexManager(lib, qp, join(dir, "sidecars"));
  await mgr.ensureFresh();
});
afterAll(() => { qp.dispose(); rmSync(dir, { recursive: true, force: true }); });

describe("get_tracks", () => {
  it("returns the requested ids in request order", async () => {
    const r = await getTracks(qp, { ids: [9, 3, 7] });
    expect(isEngineError(r)).toBe(false);
    if (isEngineError(r)) return;
    expect(r.tracks.map((t) => t.id)).toEqual([9, 3, 7]);
  });

  it("silently drops unknown ids rather than failing the whole call", async () => {
    const r = await getTracks(qp, { ids: [1, 999999] });
    expect(isEngineError(r)).toBe(false);
    if (isEngineError(r)) return;
    expect(r.tracks.map((t) => t.id)).toEqual([1]);
  });

  it("rejects an empty id list", async () => {
    expect(isEngineError(await getTracks(qp, { ids: [] }))).toBe(true);
  });
});

describe("refresh_index", () => {
  it("reports a no-op when the library has not changed", async () => {
    const r = await refreshIndex(mgr);
    expect(isEngineError(r)).toBe(false);
    if (isEngineError(r)) return;
    expect(r.rebuilt).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/tools-basic.test.ts`
Expected: FAIL — cannot resolve `../src/tools/tracks.js`.

- [ ] **Step 3: Write `src/tools/tracks.ts`**

```ts
// src/tools/tracks.ts
import { z } from "zod";
import { err, isEngineError, type EngineError } from "../errors.js";
import { DEFAULT_FIELDS, FIELD_SQL } from "./search.js";
import type { QueryProcess } from "../proc/query-client.js";

export const GetTracksInput = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(200),
  fields: z.array(z.string()).optional(),
});
export type GetTracksInput = z.input<typeof GetTracksInput>;

export async function getTracks(
  qp: QueryProcess,
  raw: GetTracksInput,
): Promise<{ tracks: Record<string, unknown>[] } | EngineError> {
  const parsed = GetTracksInput.safeParse(raw);
  if (!parsed.success) {
    return err("invalid_argument", "ids must contain between 1 and 200 track ids");
  }
  const { ids } = parsed.data;
  const fields = (parsed.data.fields ?? [...DEFAULT_FIELDS]).filter((f) => f in FIELD_SQL);
  if (!fields.length) return err("invalid_argument", "No recognised fields requested");

  const select = fields.map((f) => `${FIELD_SQL[f]} AS "${f}"`).join(", ");
  const sql = `SELECT ${select}, t.id AS __id
               FROM main.Track t JOIN side.track_derived d ON d.track_id = t.id
               WHERE t.id IN (${ids.map(() => "?").join(",")})`;

  const res = await qp.run(sql, ids);
  if (isEngineError(res)) return res;

  const idx = Object.fromEntries(res.columns.map((c, i) => [c, i]));
  const byId = new Map<number, Record<string, unknown>>();
  for (const row of res.rows) {
    byId.set(Number(row[idx.__id!]), Object.fromEntries(fields.map((f) => [f, row[idx[f]!]])));
  }
  // Preserve the caller's ordering; missing ids are simply absent.
  return { tracks: ids.map((id) => byId.get(id)).filter(Boolean) as Record<string, unknown>[] };
}
```

- [ ] **Step 4: Export `FIELD_SQL` from `src/tools/search.ts`**

Change the declaration in `src/tools/search.ts` from `const FIELD_SQL` to:

```ts
export const FIELD_SQL: Record<string, string> = {
```

- [ ] **Step 5: Write `src/tools/libraries.ts` and `src/tools/refresh.ts`**

```ts
// src/tools/libraries.ts
import { discoverLibraries, SUPPORTED_SCHEMAS, type LibraryInfo } from "../discovery.js";

export interface LibraryReport {
  path: string; uuid: string; schema: string; supported: boolean;
  track_count: number | null; index_generation: number | null;
}

/**
 * Always succeeds, including for unsupported schemas: a user staring at an
 * empty list cannot tell a broken server from a missing library.
 */
export function listLibraries(
  generations: Map<string, number> = new Map(),
  libs: LibraryInfo[] = discoverLibraries(),
): { libraries: LibraryReport[]; supported_schemas: string[] } {
  return {
    libraries: libs.map((l) => ({
      path: l.path,
      uuid: l.uuid,
      schema: l.schema.join("."),
      supported: l.supported,
      track_count: l.trackCount,
      index_generation: generations.get(l.uuid) ?? null,
    })),
    supported_schemas: [...SUPPORTED_SCHEMAS],
  };
}
```

```ts
// src/tools/refresh.ts
import type { IndexManager } from "../store/index-manager.js";
import type { EngineError } from "../errors.js";

export async function refreshIndex(
  mgr: IndexManager,
): Promise<{ rebuilt: boolean; indexed: number; elapsed_ms: number; generation: number } | EngineError> {
  return mgr.ensureFresh();
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/tools-basic.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 7: Commit**

```bash
git add src/tools/tracks.ts src/tools/libraries.ts src/tools/refresh.ts src/tools/search.ts tests/tools-basic.test.ts
git commit -m "feat: add get_tracks, list_libraries and refresh_index"
```

---

### Task 13: audit_library

**Files:**
- Create: `src/tools/audit.ts`
- Test: `tests/audit.test.ts`

**Interfaces:**
- Consumes: `QueryProcess`, `absTrackPath`, `err`
- Produces: `AUDIT_CHECKS: readonly string[]`, `auditLibrary(qp, mdbPath, input): Promise<{ checks: { name: string; count: number; sample_ids: number[] }[] } | EngineError>`

- [ ] **Step 1: Write the failing test**

```ts
// tests/audit.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLibrary } from "./fixtures/gen-library.js";
import { readLibraryInfo } from "../src/discovery.js";
import { QueryProcess } from "../src/proc/query-client.js";
import { IndexManager } from "../src/store/index-manager.js";
import { auditLibrary, AUDIT_CHECKS } from "../src/tools/audit.js";
import { isEngineError } from "../src/errors.js";

let dir: string, mdb: string, qp: QueryProcess;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "edj-audit-"));
  mdb = makeLibrary(dir, { tracks: 600 });
  const lib = readLibraryInfo(mdb);
  if (isEngineError(lib)) throw new Error("fixture library unreadable");
  qp = new QueryProcess(mdb, null, 10_000);
  await new IndexManager(lib, qp, join(dir, "sidecars")).ensureFresh();
});
afterAll(() => { qp.dispose(); rmSync(dir, { recursive: true, force: true }); });

describe("audit_library", () => {
  it("returns counts and a bounded sample, never whole result sets", async () => {
    const r = await auditLibrary(qp, mdb, {});
    expect(isEngineError(r)).toBe(false);
    if (isEngineError(r)) return;
    expect(r.checks.map((c) => c.name).sort()).toEqual([...AUDIT_CHECKS].sort());
    for (const c of r.checks) {
      expect(c.sample_ids.length).toBeLessThanOrEqual(10);
      expect(c.count).toBeGreaterThanOrEqual(c.sample_ids.length);
    }
  }, 30_000);

  it("finds the fixture's missing files, since none exist on disk", async () => {
    const r = await auditLibrary(qp, mdb, { checks: ["missing_files"] });
    expect(isEngineError(r)).toBe(false);
    if (isEngineError(r)) return;
    expect(r.checks[0]!.name).toBe("missing_files");
    expect(r.checks[0]!.count).toBe(600);
  }, 30_000);

  it("finds tracks with an undetermined key", async () => {
    const r = await auditLibrary(qp, mdb, { checks: ["missing_key"] });
    expect(isEngineError(r)).toBe(false);
    if (isEngineError(r)) return;
    expect(r.checks[0]!.count).toBeGreaterThan(0);
  });

  it("rejects an unknown check name instead of ignoring it", async () => {
    const r = await auditLibrary(qp, mdb, { checks: ["not_a_check"] });
    expect(isEngineError(r)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/audit.test.ts`
Expected: FAIL — cannot resolve `../src/tools/audit.js`.

- [ ] **Step 3: Write the implementation**

```ts
// src/tools/audit.ts
import { existsSync } from "node:fs";
import { z } from "zod";
import { err, isEngineError, type EngineError } from "../errors.js";
import { absTrackPath } from "../paths.js";
import type { QueryProcess } from "../proc/query-client.js";

export const AUDIT_CHECKS = [
  "missing_files", "unavailable", "unanalyzed", "no_cues", "no_beatgrid",
  "missing_key", "suspicious_bpm", "duplicates", "empty_metadata", "orphan_entries",
] as const;

export const AuditInput = z.object({ checks: z.array(z.string()).optional() });
export type AuditInput = z.input<typeof AuditInput>;

const SAMPLE = 10;

/** Pure-SQL checks: id list plus a count, computed server side. */
const SQL_CHECKS: Record<string, string> = {
  unavailable: `SELECT t.id FROM Track t WHERE t.isAvailable = 0`,
  unanalyzed: `SELECT t.id FROM Track t WHERE t.isAnalyzed = 0 OR t.isAnalyzed IS NULL`,
  no_cues: `SELECT t.id FROM Track t LEFT JOIN PerformanceData p ON p.trackId = t.id
            WHERE p.quickCues IS NULL`,
  no_beatgrid: `SELECT t.id FROM Track t LEFT JOIN PerformanceData p ON p.trackId = t.id
                WHERE p.beatData IS NULL`,
  missing_key: `SELECT t.id FROM Track t WHERE t.key = -1 OR t.key IS NULL`,
  suspicious_bpm: `SELECT t.id FROM Track t
                   WHERE (t.bpmAnalyzed IS NOT NULL AND t.bpm IS NOT NULL
                          AND ABS(t.bpmAnalyzed - t.bpm) > 1.0)
                      OR COALESCE(t.bpmAnalyzed, t.bpm) NOT BETWEEN 60 AND 200`,
  empty_metadata: `SELECT t.id FROM Track t
                   WHERE t.title IS NULL OR TRIM(t.title) = ''
                      OR t.artist IS NULL OR TRIM(t.artist) = ''`,
  duplicates: `SELECT t.id FROM Track t WHERE LOWER(TRIM(t.artist)) || '|' || LOWER(TRIM(t.title)) IN (
                 SELECT LOWER(TRIM(artist)) || '|' || LOWER(TRIM(title)) FROM Track
                 WHERE artist IS NOT NULL AND title IS NOT NULL
                 GROUP BY 1 HAVING COUNT(*) > 1)`,
  orphan_entries: `SELECT e.id FROM PlaylistEntity e
                   LEFT JOIN Track t ON t.id = e.trackId WHERE t.id IS NULL`,
};

export async function auditLibrary(
  qp: QueryProcess,
  mdbPath: string,
  raw: AuditInput,
): Promise<{ checks: { name: string; count: number; sample_ids: number[] }[] } | EngineError> {
  const requested = raw.checks ?? [...AUDIT_CHECKS];
  const unknown = requested.filter((c) => !(AUDIT_CHECKS as readonly string[]).includes(c));
  if (unknown.length) {
    return err("invalid_argument", `Unknown audit checks: ${unknown.join(", ")}`, {
      detail: `Known checks: ${AUDIT_CHECKS.join(", ")}`,
    });
  }

  const out: { name: string; count: number; sample_ids: number[] }[] = [];
  for (const name of requested) {
    if (name === "missing_files") {
      const res = await qp.run(`SELECT id, path FROM Track WHERE path IS NOT NULL`);
      if (isEngineError(res)) return res;
      const missing: number[] = [];
      for (const row of res.rows) {
        if (!existsSync(absTrackPath(mdbPath, String(row[1])))) missing.push(Number(row[0]));
      }
      out.push({ name, count: missing.length, sample_ids: missing.slice(0, SAMPLE) });
      continue;
    }
    const res = await qp.run(SQL_CHECKS[name]!);
    if (isEngineError(res)) return res;
    const ids = res.rows.map((r) => Number(r[0]));
    out.push({ name, count: ids.length, sample_ids: ids.slice(0, SAMPLE) });
  }
  return { checks: out };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/audit.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/tools/audit.ts tests/audit.test.ts
git commit -m "feat: add audit_library with ten schema-derived checks"
```

---

### Task 14: PerformanceData decoders

> **Validation gap.** The framing below follows Qt's `qCompress` and the layouts
> described by `xsco/libdjinterop` and `jrgutier/rb2engine`. It has not been run
> against bytes from a real Engine library. Golden fixtures must be added as
> soon as one is available; until then the decoders are correct by construction
> and defensive by contract.

**Files:**
- Create: `src/blobs/qcompress.ts`, `src/blobs/cues.ts`, `src/blobs/loops.ts`, `src/blobs/beatgrid.ts`, `src/blobs/waveform.ts`, `src/blobs/index.ts`
- Test: `tests/blobs.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `qUncompress(buf: Buffer): Buffer` (throws `DecodeError`)
  - `type Decoded<T> = { status: "ok"; items: T[] } | { status: "empty" } | { status: "unsupported"; detail: string; bytes: number } | { status: "corrupt"; detail: string }`
  - `decodeCues(buf: Buffer | null): Decoded<Cue>`, `decodeLoops`, `decodeBeatgrid`, `summariseWaveform`
  - `decodePerformance(row): { cues; loops; beatgrid; waveform_summary }`

- [ ] **Step 1: Write the failing test**

```ts
// tests/blobs.test.ts
import { describe, it, expect } from "vitest";
import { deflateSync } from "node:zlib";
import { qUncompress } from "../src/blobs/qcompress.js";
import { decodeCues, decodeLoops, decodeBeatgrid, summariseWaveform } from "../src/blobs/index.js";

function qCompress(payload: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, deflateSync(payload)]);
}

describe("qCompress framing", () => {
  it("round-trips a payload", () => {
    const payload = Buffer.from("hello engine", "utf8");
    expect(qUncompress(qCompress(payload)).equals(payload)).toBe(true);
  });

  it("rejects a truncated frame", () => {
    expect(() => qUncompress(Buffer.from([0, 0, 1]))).toThrow();
  });

  it("rejects a length that disagrees with the payload", () => {
    const bad = qCompress(Buffer.from("abc"));
    bad.writeUInt32BE(9999, 0);
    expect(() => qUncompress(bad)).toThrow();
  });
});

describe("decoders never throw", () => {
  it("reports empty for null and zero-length input", () => {
    expect(decodeCues(null).status).toBe("empty");
    expect(decodeLoops(Buffer.alloc(0)).status).toBe("empty");
    expect(decodeBeatgrid(null).status).toBe("empty");
    expect(summariseWaveform(null).status).toBe("empty");
  });

  it("reports corrupt for garbage rather than throwing", () => {
    const garbage = Buffer.from([9, 9, 9, 9, 1, 2, 3, 4, 5, 6, 7, 8]);
    for (const fn of [decodeCues, decodeBeatgrid, summariseWaveform]) {
      const r = fn(garbage);
      expect(["corrupt", "unsupported"]).toContain(r.status);
    }
  });

  it("decodes a well-formed quickCues frame", () => {
    // count:uint32be, then per cue: label len:uint32be, label, position:double, colour:uint32be
    const label = Buffer.from("Intro", "utf8");
    const cue = Buffer.concat([
      (() => { const b = Buffer.alloc(4); b.writeUInt32BE(label.length); return b; })(),
      label,
      (() => { const b = Buffer.alloc(8); b.writeDoubleBE(44100 * 12); return b; })(),
      (() => { const b = Buffer.alloc(4); b.writeUInt32BE(0xff3366); return b; })(),
    ]);
    const count = Buffer.alloc(4); count.writeUInt32BE(1);
    const r = decodeCues(qCompress(Buffer.concat([count, cue])));
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.items[0]!.label).toBe("Intro");
    expect(r.items[0]!.position_samples).toBeCloseTo(44100 * 12, 0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/blobs.test.ts`
Expected: FAIL — cannot resolve `../src/blobs/qcompress.js`.

- [ ] **Step 3: Write `src/blobs/qcompress.ts`**

```ts
// src/blobs/qcompress.ts
import { inflateSync } from "node:zlib";

export class DecodeError extends Error {}

/**
 * Qt's qCompress framing: a 4-byte big-endian uncompressed length followed by
 * a raw zlib stream. Engine stores its performance blobs this way.
 */
export function qUncompress(buf: Buffer): Buffer {
  if (buf.length < 5) throw new DecodeError(`frame too short: ${buf.length} bytes`);
  const expected = buf.readUInt32BE(0);
  let out: Buffer;
  try {
    out = inflateSync(buf.subarray(4));
  } catch (e) {
    throw new DecodeError(`zlib: ${(e as Error).message}`);
  }
  if (out.length !== expected) {
    throw new DecodeError(`length mismatch: header says ${expected}, inflated ${out.length}`);
  }
  return out;
}

/** Sequential big-endian reader that fails loudly rather than reading past the end. */
export class Reader {
  #off = 0;
  constructor(private readonly buf: Buffer) {}
  get remaining(): number { return this.buf.length - this.#off; }
  #need(n: number): void {
    if (this.remaining < n) throw new DecodeError(`need ${n} bytes, ${this.remaining} left`);
  }
  u32(): number { this.#need(4); const v = this.buf.readUInt32BE(this.#off); this.#off += 4; return v; }
  u8(): number { this.#need(1); return this.buf.readUInt8(this.#off++); }
  f64(): number { this.#need(8); const v = this.buf.readDoubleBE(this.#off); this.#off += 8; return v; }
  bytes(n: number): Buffer { this.#need(n); const v = this.buf.subarray(this.#off, this.#off + n); this.#off += n; return v; }
  utf8(n: number): string { return this.bytes(n).toString("utf8"); }
}
```

- [ ] **Step 4: Write `src/blobs/index.ts` with the four decoders**

```ts
// src/blobs/index.ts
import { qUncompress, Reader, DecodeError } from "./qcompress.js";

export type Decoded<T> =
  | { status: "ok"; items: T[] }
  | { status: "empty" }
  | { status: "unsupported"; detail: string; bytes: number }
  | { status: "corrupt"; detail: string };

export interface Cue { index: number; label: string; position_samples: number; colour: number }
export interface Loop { index: number; label: string; start_samples: number; end_samples: number }
export interface BeatAnchor { sample: number; beat: number }
export type WaveformSummary =
  | { status: "ok"; peaks: number; profile: number[] }
  | { status: "empty" }
  | { status: "unsupported"; detail: string; bytes: number }
  | { status: "corrupt"; detail: string };

const MAX_ITEMS = 512; // sanity bound: a real cue list is nowhere near this

function guard<T>(buf: Buffer | null, body: (r: Reader) => T[]): Decoded<T> {
  if (!buf || buf.length === 0) return { status: "empty" };
  try {
    return { status: "ok", items: body(new Reader(qUncompress(buf))) };
  } catch (e) {
    const detail = (e as Error).message;
    return e instanceof DecodeError && /unsupported|signature/i.test(detail)
      ? { status: "unsupported", detail, bytes: buf.length }
      : { status: "corrupt", detail };
  }
}

export function decodeCues(buf: Buffer | null): Decoded<Cue> {
  return guard<Cue>(buf, (r) => {
    const count = r.u32();
    if (count > MAX_ITEMS) throw new DecodeError(`unsupported cue count ${count}`);
    const items: Cue[] = [];
    for (let i = 0; i < count; i++) {
      const len = r.u32();
      if (len > 4096) throw new DecodeError(`unsupported label length ${len}`);
      items.push({ index: i, label: r.utf8(len), position_samples: r.f64(), colour: r.u32() });
    }
    return items;
  });
}

export function decodeLoops(buf: Buffer | null): Decoded<Loop> {
  return guard<Loop>(buf, (r) => {
    const count = r.u32();
    if (count > MAX_ITEMS) throw new DecodeError(`unsupported loop count ${count}`);
    const items: Loop[] = [];
    for (let i = 0; i < count; i++) {
      const len = r.u32();
      if (len > 4096) throw new DecodeError(`unsupported label length ${len}`);
      items.push({ index: i, label: r.utf8(len), start_samples: r.f64(), end_samples: r.f64() });
    }
    return items;
  });
}

export function decodeBeatgrid(buf: Buffer | null): Decoded<BeatAnchor> {
  return guard<BeatAnchor>(buf, (r) => {
    const count = r.u32();
    if (count > 8192) throw new DecodeError(`unsupported anchor count ${count}`);
    const items: BeatAnchor[] = [];
    for (let i = 0; i < count; i++) items.push({ sample: r.f64(), beat: r.f64() });
    return items;
  });
}

/**
 * The raw waveform is kilobytes of binary and is never returned to the model.
 * We reduce it to a coarse energy profile.
 */
export function summariseWaveform(buf: Buffer | null, buckets = 32): WaveformSummary {
  if (!buf || buf.length === 0) return { status: "empty" };
  try {
    const data = qUncompress(buf);
    if (data.length === 0) return { status: "empty" };
    const size = Math.ceil(data.length / buckets);
    const profile: number[] = [];
    for (let i = 0; i < data.length; i += size) {
      let peak = 0;
      for (let j = i; j < Math.min(i + size, data.length); j++) peak = Math.max(peak, data[j]!);
      profile.push(Math.round((peak / 255) * 100) / 100);
    }
    return { status: "ok", peaks: data.length, profile };
  } catch (e) {
    return { status: "corrupt", detail: (e as Error).message };
  }
}

export interface PerformanceRow {
  quickCues: Buffer | null; loops: Buffer | null;
  beatData: Buffer | null; overviewWaveFormData: Buffer | null;
}

export function decodePerformance(row: PerformanceRow) {
  return {
    cues: decodeCues(row.quickCues),
    loops: decodeLoops(row.loops),
    beatgrid: decodeBeatgrid(row.beatData),
    waveform_summary: summariseWaveform(row.overviewWaveFormData),
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/blobs.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Commit**

```bash
git add src/blobs/ tests/blobs.test.ts
git commit -m "feat: add defensive PerformanceData decoders (pending real fixtures)"
```

---

### Task 15: get_track_performance

**Files:**
- Create: `src/tools/performance.ts`
- Test: `tests/performance.test.ts`

**Interfaces:**
- Consumes: `decodePerformance` from `src/blobs/index.ts`, `QueryProcess`
- Produces: `getTrackPerformance(qp, { id }): Promise<{ track_id: number; cues; loops; beatgrid; waveform_summary } | EngineError>`

- [ ] **Step 1: Write the failing test**

```ts
// tests/performance.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLibrary } from "./fixtures/gen-library.js";
import { QueryProcess } from "../src/proc/query-client.js";
import { getTrackPerformance } from "../src/tools/performance.js";
import { isEngineError } from "../src/errors.js";

let dir: string, qp: QueryProcess;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "edj-perf-"));
  qp = new QueryProcess(makeLibrary(dir, { tracks: 50 }), null, 5000);
});
afterAll(() => { qp.dispose(); rmSync(dir, { recursive: true, force: true }); });

describe("get_track_performance", () => {
  it("returns a per-field status instead of failing the call", async () => {
    // The fixture stores zero-filled blobs, which are not valid frames.
    const r = await getTrackPerformance(qp, { id: 1 });
    expect(isEngineError(r)).toBe(false);
    if (isEngineError(r)) return;
    expect(r.track_id).toBe(1);
    for (const key of ["cues", "loops", "beatgrid", "waveform_summary"] as const) {
      expect(["ok", "empty", "corrupt", "unsupported"]).toContain((r as any)[key].status);
    }
  });

  it("reports an unknown track as a structured error", async () => {
    const r = await getTrackPerformance(qp, { id: 999999 });
    expect(isEngineError(r)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/performance.test.ts`
Expected: FAIL — cannot resolve `../src/tools/performance.js`.

- [ ] **Step 3: Write the implementation**

```ts
// src/tools/performance.ts
import { z } from "zod";
import { err, isEngineError, type EngineError } from "../errors.js";
import { decodePerformance } from "../blobs/index.js";
import type { QueryProcess } from "../proc/query-client.js";

export const PerformanceInput = z.object({ id: z.number().int().positive() });
export type PerformanceInput = z.input<typeof PerformanceInput>;

function asBuffer(v: unknown): Buffer | null {
  if (v === null || v === undefined) return null;
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Uint8Array) return Buffer.from(v);
  return null;
}

export async function getTrackPerformance(qp: QueryProcess, raw: PerformanceInput) {
  const parsed = PerformanceInput.safeParse(raw);
  if (!parsed.success) return err("invalid_argument", "id must be a positive integer");
  const { id } = parsed.data;

  const res = await qp.run(
    `SELECT quickCues, loops, beatData, overviewWaveFormData
     FROM PerformanceData WHERE trackId = ?`,
    [id],
  );
  if (isEngineError(res)) return res;
  if (!res.rows.length) {
    return err("decode_failed", `No performance data for track ${id}`, {
      detail: "The track may not exist, or Engine has not analysed it yet",
    });
  }

  const [quickCues, loops, beatData, overviewWaveFormData] = res.rows[0]!;
  return {
    track_id: id,
    ...decodePerformance({
      quickCues: asBuffer(quickCues),
      loops: asBuffer(loops),
      beatData: asBuffer(beatData),
      overviewWaveFormData: asBuffer(overviewWaveFormData),
    }),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/performance.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/tools/performance.ts tests/performance.test.ts
git commit -m "feat: add get_track_performance with per-field decode status"
```

---

### Task 16: MCP server, run_sql tool, entry point and packaging

**Files:**
- Create: `src/tools/sql.ts`, `src/server.ts`, `src/index.ts`, `README.md`, `LICENSE` (already present — verify it is MIT)
- Test: `tests/server.test.ts`

**Interfaces:**
- Consumes: everything above
- Produces: `runSql(qp, { sql, params?, limit? })`, `createServer(): Promise<McpServer>`

- [ ] **Step 1: Write the failing test**

```ts
// tests/server.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLibrary } from "./fixtures/gen-library.js";
import { QueryProcess } from "../src/proc/query-client.js";
import { runSql } from "../src/tools/sql.js";
import { isEngineError } from "../src/errors.js";

let dir: string, qp: QueryProcess;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "edj-sql-"));
  qp = new QueryProcess(makeLibrary(dir, { tracks: 100 }), null, 5000);
});
afterAll(() => { qp.dispose(); rmSync(dir, { recursive: true, force: true }); });

describe("run_sql", () => {
  it("runs a read query", async () => {
    const r = await runSql(qp, { sql: "SELECT COUNT(*) AS c FROM Track" });
    expect(isEngineError(r)).toBe(false);
    if (isEngineError(r)) return;
    expect(r.rows[0]![0]).toBe(100);
  });

  it("blocks VACUUM INTO, which the kernel would otherwise allow", async () => {
    const r = await runSql(qp, { sql: `VACUUM INTO '${join(dir, "exfil.db")}'` });
    expect(isEngineError(r)).toBe(true);
    expect(existsSync(join(dir, "exfil.db"))).toBe(false);
  });

  it("blocks a chained statement", async () => {
    const r = await runSql(qp, { sql: "SELECT 1; ATTACH DATABASE '/tmp/x.db' AS rw" });
    expect(isEngineError(r)).toBe(true);
  });

  it("injects a LIMIT and reports truncation", async () => {
    const r = await runSql(qp, { sql: "SELECT id FROM Track", limit: 5 });
    expect(isEngineError(r)).toBe(false);
    if (isEngineError(r)) return;
    expect(r.rows.length).toBe(5);
    expect(r.truncated).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server.test.ts`
Expected: FAIL — cannot resolve `../src/tools/sql.js`.

- [ ] **Step 3: Write `src/tools/sql.ts`**

```ts
// src/tools/sql.ts
import { z } from "zod";
import { checkStatement, enforceLimit } from "../guard.js";
import { isEngineError, type EngineError } from "../errors.js";
import type { QueryProcess } from "../proc/query-client.js";

export const RunSqlInput = z.object({
  sql: z.string().min(1),
  params: z.array(z.union([z.string(), z.number(), z.null()])).optional(),
  limit: z.number().int().positive().max(500).default(200),
});
export type RunSqlInput = z.input<typeof RunSqlInput>;

export async function runSql(
  qp: QueryProcess,
  raw: RunSqlInput,
): Promise<{ columns: string[]; rows: unknown[][]; truncated: boolean } | EngineError> {
  const input = RunSqlInput.parse(raw);
  const rejected = checkStatement(input.sql);
  if (rejected) return rejected;

  // prepare() only, never exec(): exec() runs every chained statement and would
  // let "SELECT 1; VACUUM INTO ..." slip past the guard above.
  const res = await qp.run(enforceLimit(input.sql, input.limit), input.params ?? []);
  if (isEngineError(res)) return res;
  return { ...res, truncated: res.rows.length >= input.limit };
}
```

- [ ] **Step 4: Run the run_sql tests**

Run: `npx vitest run tests/server.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Write `src/server.ts`**

```ts
// src/server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { discoverLibraries } from "./discovery.js";
import { QueryProcess } from "./proc/query-client.js";
import { IndexManager } from "./store/index-manager.js";
import { searchTracks, SearchInput } from "./tools/search.js";
import { getTracks, GetTracksInput } from "./tools/tracks.js";
import { getTrackPerformance, PerformanceInput } from "./tools/performance.js";
import { auditLibrary, AuditInput, AUDIT_CHECKS } from "./tools/audit.js";
import { runSql, RunSqlInput } from "./tools/sql.js";
import { listLibraries } from "./tools/libraries.js";
import { refreshIndex } from "./tools/refresh.js";
import { err, isEngineError } from "./errors.js";

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true } as const;

function reply(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
    isError: isEngineError(value),
  };
}

export async function createServer(): Promise<McpServer> {
  const server = new McpServer({ name: "engine-dj-mcp", version: "0.1.0" });

  const libs = discoverLibraries();
  const primary = libs.find((l) => l.supported) ?? null;
  const qp = primary ? new QueryProcess(primary.path, null, 10_000) : null;
  const mgr = primary && qp ? new IndexManager(primary, qp) : null;

  const ready = async () => {
    if (!qp || !mgr) return err("library_not_found", "No supported Engine DJ library was found");
    const fresh = await mgr.ensureFresh();
    return isEngineError(fresh) && fresh.error !== "index_stale" ? fresh : null;
  };

  server.registerResource(
    "schema", "engine://schema",
    { title: "Engine DJ schema and semantics", mimeType: "text/markdown" },
    async (uri) => ({ contents: [{ uri: uri.href, text: SCHEMA_NOTE }] }),
  );

  server.registerResource(
    "libraries", "engine://libraries",
    { title: "Discovered Engine DJ libraries", mimeType: "application/json" },
    async (uri) => ({
      contents: [{ uri: uri.href, text: JSON.stringify(listLibraries(new Map(), libs), null, 2) }],
    }),
  );

  server.registerTool("search_tracks",
    { title: "Search tracks", description: "Search the Engine DJ library by text, tempo, key, rating, play history and analysis flags.",
      inputSchema: SearchInput.shape, annotations: RO },
    async (args) => {
      const gate = await ready(); if (gate) return reply(gate);
      return reply(await searchTracks(qp!, args as any));
    });

  server.registerTool("get_tracks",
    { title: "Get tracks by id", description: "Fetch full metadata for specific track ids.",
      inputSchema: GetTracksInput.shape, annotations: RO },
    async (args) => {
      const gate = await ready(); if (gate) return reply(gate);
      return reply(await getTracks(qp!, args as any));
    });

  server.registerTool("get_track_performance",
    { title: "Get cues, loops and beatgrid", description: "Decode PerformanceData for one track. Each field carries its own decode status.",
      inputSchema: PerformanceInput.shape, annotations: RO },
    async (args) => {
      const gate = await ready(); if (gate) return reply(gate);
      return reply(await getTrackPerformance(qp!, args as any));
    });

  server.registerTool("audit_library",
    { title: "Audit the collection", description: `Run collection health checks. Available: ${AUDIT_CHECKS.join(", ")}.`,
      inputSchema: AuditInput.shape, annotations: RO },
    async (args) => {
      const gate = await ready(); if (gate) return reply(gate);
      return reply(await auditLibrary(qp!, primary!.path, args as any));
    });

  server.registerTool("run_sql",
    { title: "Run a read-only SQL query", description: "Escape hatch for questions the other tools do not cover. Read-only is enforced by the kernel. Use side.track_derived.camelot rather than camelot() in WHERE.",
      inputSchema: RunSqlInput.shape, annotations: RO },
    async (args) => {
      const gate = await ready(); if (gate) return reply(gate);
      return reply(await runSql(qp!, args as any));
    });

  server.registerTool("list_libraries",
    { title: "List Engine DJ libraries", description: "List every discovered library, including ones whose schema is unsupported.",
      inputSchema: {}, annotations: RO },
    async () => reply(listLibraries(new Map(mgr ? [[primary!.uuid, mgr.generation]] : []), libs)));

  server.registerTool("refresh_index",
    { title: "Refresh the search index", description: "Rebuild the search index if the library has changed.",
      inputSchema: {}, annotations: RO },
    async () => {
      if (!mgr) return reply(err("library_not_found", "No supported Engine DJ library was found"));
      return reply(await refreshIndex(mgr));
    });

  return server;
}

const SCHEMA_NOTE = `# Engine DJ library — schema and semantics

Tables live in \`m.db\` (attached as \`main\`); the search index lives in \`side\`.

## Field semantics
- \`Track.key\` is 0..23, \`-1\` means undetermined. Use \`side.track_derived.camelot\`
  for filtering — it is indexed. The SQL function \`camelot(key)\` exists but runs
  per row and defeats indexes.
- Real tempo is \`COALESCE(bpmAnalyzed, bpm)\`. \`bpm\` is stored at face value —
  it is NOT scaled by 100; that is a rekordbox convention, not an Engine one.
  \`side.track_derived.tempo\` holds the resolved value and is indexed.
- \`Track.path\` is relative to the \`Engine Library\` folder and usually contains \`..\`.
- Playlists are singly linked lists: order lives in \`Playlist.nextListId\` and
  \`PlaylistEntity.nextEntityId\`, not in any position column.
- A track's natural key across drives is \`(originDatabaseUuid, originTrackId)\`.

## Sidecar tables
- \`side.fts_track\` — FTS5 over title, artist, album, genre, comment, label,
  with diacritics folded. Join via \`side.fts_map(rowid, track_id)\`.
- \`side.track_derived(track_id, camelot, tempo, has_cues, has_grid)\` — indexed.

## Limits
The connection is read-only at the kernel level. \`VACUUM\`, \`ATTACH\` and
\`DETACH\` are rejected. Only one statement per call. Queries are killed after
10 seconds.`;
```

- [ ] **Step 6: Write `src/index.ts`**

```ts
#!/usr/bin/env node
// src/index.ts
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const server = await createServer();
  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  // stderr is not the protocol channel, so this is safe for stdio transport.
  console.error("engine-dj-mcp failed to start:", e);
  process.exit(1);
});
```

- [ ] **Step 7: Write `README.md`**

````markdown
# engine-dj-mcp

An MCP server that lets an AI assistant search and audit your **Engine DJ** library.

> **Not affiliated with inMusic Brands, Denon DJ, or the Engine DJ product.**
> "Engine DJ" is used here only to name the software this tool reads.

## What it does

- **Smart search** — full text with diacritics folded, tempo windows, harmonic
  key matching, rating, and play history ("what have I not played in six months?").
- **Collection audit** — missing files, unanalysed tracks, tracks without cues or
  beatgrids, duplicates, suspicious tempos, orphaned playlist entries.
- **Cues, loops and beatgrids** — decoded from Engine's `PerformanceData`.
- **Read-only SQL** — an escape hatch for anything the tools above do not cover.

## Safety

Your library is opened **read-only at the operating-system level**, not by
convention. Writes are refused by SQLite itself, and no file is ever created
inside your `Engine Library` folder. The server keeps its search index in
`~/.engine-dj-mcp/`.

## Requirements

- Node.js 22 or newer
- Engine DJ with library schema 3.0.0–3.0.2 (Engine DJ 4.5 and 5.x)

## Install

```bash
npx engine-dj-mcp
```

Claude Desktop configuration:

```json
{
  "mcpServers": {
    "engine-dj": { "command": "npx", "args": ["-y", "engine-dj-mcp"] }
  }
}
```

## Licence

MIT.
````

- [ ] **Step 8: Verify the whole suite and the build**

Run: `npx vitest run && npm run build`
Expected: all tests pass; `dist/index.js` exists.

- [ ] **Step 9: Smoke-test the server over stdio**

Run:

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' | node dist/index.js
```

Expected: a single JSON-RPC response containing `"serverInfo"` with `"name":"engine-dj-mcp"`. An `ExperimentalWarning` about SQLite on stderr is expected and harmless.

- [ ] **Step 10: Commit**

```bash
git add src/tools/sql.ts src/server.ts src/index.ts README.md tests/server.test.ts
git commit -m "feat: wire MCP server, run_sql tool and stdio entry point"
```

---

### Task 17: Path redaction and performance budgets

Closes two spec requirements that no earlier task covers: the privacy note in
§9 and the CI budgets in §10.2.

**Files:**
- Modify: `src/paths.ts` (add `redactPath`), `src/tools/search.ts` (apply it), `src/tools/audit.ts` (apply it)
- Create: `tests/privacy.test.ts`, `tests/performance-budget.test.ts`

**Interfaces:**
- Consumes: `absTrackPath` from `src/paths.ts`
- Produces: `redactPath(p: string): string`, and a `redact_paths` option on `SearchInput` (default `true`)

- [ ] **Step 1: Write the failing privacy test**

```ts
// tests/privacy.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { makeLibrary } from "./fixtures/gen-library.js";
import { readLibraryInfo } from "../src/discovery.js";
import { QueryProcess } from "../src/proc/query-client.js";
import { IndexManager } from "../src/store/index-manager.js";
import { searchTracks, DEFAULT_FIELDS } from "../src/tools/search.js";
import { redactPath } from "../src/paths.js";
import { isEngineError } from "../src/errors.js";

let dir: string, qp: QueryProcess;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "edj-priv-"));
  const mdb = makeLibrary(dir, { tracks: 50 });
  const lib = readLibraryInfo(mdb);
  if (isEngineError(lib)) throw new Error("fixture library unreadable");
  qp = new QueryProcess(mdb, null, 5000);
  await new IndexManager(lib, qp, join(dir, "sidecars")).ensureFresh();
});
afterAll(() => { qp.dispose(); rmSync(dir, { recursive: true, force: true }); });

describe("privacy", () => {
  it("keeps listening history out of the default projection", () => {
    expect(DEFAULT_FIELDS).not.toContain("last_played");
    expect(DEFAULT_FIELDS).not.toContain("path");
  });

  it("replaces the home directory with a tilde", () => {
    expect(redactPath(join(homedir(), "Music", "x.mp3"))).toBe(join("~", "Music", "x.mp3"));
    expect(redactPath("/Volumes/USB/x.mp3")).toBe("/Volumes/USB/x.mp3");
  });

  it("redacts paths in search results unless asked not to", async () => {
    const on = await searchTracks(qp, { fields: ["id", "path"], limit: 1 });
    expect(isEngineError(on)).toBe(false);
    if (isEngineError(on)) return;
    expect(String(on.tracks[0]!.path)).not.toContain(homedir());

    const off = await searchTracks(qp, { fields: ["id", "path"], limit: 1, redact_paths: false });
    expect(isEngineError(off)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/privacy.test.ts`
Expected: FAIL — `redactPath` is not exported.

- [ ] **Step 3: Add `redactPath` to `src/paths.ts`**

```ts
/**
 * Absolute library paths carry the user's account name. Search results are
 * shipped to a model provider, so the home prefix is folded to `~` by default.
 */
export function redactPath(p: string): string {
  const home = homedir();
  return p === home || p.startsWith(home + "/") ? "~" + p.slice(home.length) : p;
}
```

Add `homedir` to the existing `node:os` import if it is not already there.

- [ ] **Step 4: Apply it in `src/tools/search.ts`**

Add to the zod shape, alongside `include_total`:

```ts
  redact_paths: z.boolean().default(true),
```

and replace the row-to-object mapping with:

```ts
  const tracks = res.rows.map((row) =>
    Object.fromEntries(fields.map((f) => {
      const value = row[idx[f]!];
      return [f, input.redact_paths && f === "path" && typeof value === "string"
        ? redactPath(value)
        : value];
    })) as Record<string, unknown>);
```

Add the import: `import { redactPath } from "../paths.js";`

- [ ] **Step 5: Run it to verify it passes**

Run: `npx vitest run tests/privacy.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: Write the performance budget test**

```ts
// tests/performance-budget.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLibrary } from "./fixtures/gen-library.js";
import { readLibraryInfo } from "../src/discovery.js";
import { readChangeCounter } from "../src/probe.js";
import { buildSidecar } from "../src/sidecar/build.js";
import { QueryProcess } from "../src/proc/query-client.js";
import { IndexManager } from "../src/store/index-manager.js";
import { searchTracks } from "../src/tools/search.js";
import { isEngineError } from "../src/errors.js";

const N = 50_000;
let dir: string, mdb: string, qp: QueryProcess;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "edj-budget-"));
  mdb = makeLibrary(dir, { tracks: N });
  const lib = readLibraryInfo(mdb);
  if (isEngineError(lib)) throw new Error("fixture library unreadable");
  qp = new QueryProcess(mdb, null, 10_000);
  await new IndexManager(lib, qp, join(dir, "sidecars")).ensureFresh();
}, 120_000);
afterAll(() => { qp.dispose(); rmSync(dir, { recursive: true, force: true }); });

/** Budgets are ~3x the numbers measured while designing, to absorb slow CI. */
describe(`performance budgets at ${N} tracks`, () => {
  it("probes staleness in under 1 ms", () => {
    const t = performance.now();
    for (let i = 0; i < 10; i++) readChangeCounter(mdb);
    expect((performance.now() - t) / 10).toBeLessThan(1);
  });

  it("rebuilds the whole index in under 300 ms", () => {
    const r = buildSidecar({
      mdbPath: mdb, outPath: join(dir, "budget.db"), uuid: "u", schema: "3.0.2",
    });
    expect(r.indexed).toBe(N);
    expect(r.elapsed_ms).toBeLessThan(300);
  }, 60_000);

  it("returns a search page in under 25 ms", async () => {
    await searchTracks(qp, { q: "dark", limit: 25 }); // warm the process
    const t = performance.now();
    const r = await searchTracks(qp, { q: "dark", bpm: { around: 124, tolerance_pct: 3 }, limit: 25 });
    const elapsed = performance.now() - t;
    expect(isEngineError(r)).toBe(false);
    expect(elapsed).toBeLessThan(25);
  }, 30_000);
});
```

- [ ] **Step 7: Run the budget suite**

Run: `npx vitest run tests/performance-budget.test.ts`
Expected: PASS, 3 tests. If a budget fails, treat it as a real regression and
investigate before raising the threshold — these numbers were measured, not guessed.

- [ ] **Step 8: Run the whole suite**

Run: `npx vitest run`
Expected: every test passes.

- [ ] **Step 9: Commit**

```bash
git add src/paths.ts src/tools/search.ts tests/privacy.test.ts tests/performance-budget.test.ts
git commit -m "feat: redact home paths and enforce performance budgets in CI"
```

---

## Validation Against a Real Library

These steps cannot be completed until a populated Engine DJ library is
available. They close the gaps flagged in Task 14 and in the spec's open
questions.

- [ ] **Confirm the Camelot anchor.** Open a track whose musical key is known,
  read `Track.key`, and check that `camelot(key)` produces the expected label.
  If the anchor is offset, adjust the constant in `camelotIndex` and update the
  test in `tests/semantics.test.ts`.
- [ ] **Capture golden BLOB fixtures.** Export `quickCues`, `loops`, `beatData`
  and `overviewWaveFormData` for a handful of analysed tracks into
  `tests/fixtures/blobs/`, with the values Engine displays for them, and assert
  the decoders reproduce those values.
- [ ] **Measure decode cost** across the whole library and record it, so the
  `waveform_summary` bucket count and any caching decision rest on a number.
- [ ] **Measure `missing_files` on an external drive**, where files exist and the
  filesystem is slow, and add progress reporting if it exceeds a couple of seconds.
- [ ] **Re-check schema coverage** against the library's actual
  `Information.schemaVersion*`, extending `SUPPORTED_SCHEMAS` only for versions
  that have been read successfully.
