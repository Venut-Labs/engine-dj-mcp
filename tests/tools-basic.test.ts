// tests/tools-basic.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { makeLibrary } from "./fixtures/gen-library.js";
import { readLibraryInfo } from "../src/discovery.js";
import { QueryProcess } from "../src/proc/query-client.js";
import { IndexManager } from "../src/store/index-manager.js";
import { getTracks } from "../src/tools/tracks.js";
import { listLibraries } from "../src/tools/libraries.js";
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

  it("rejects unknown fields with named detail, matching search_tracks", async () => {
    const r = await getTracks(qp, { ids: [1, 2], fields: ["id", "unknown_field"] });
    expect(isEngineError(r)).toBe(true);
    if (!isEngineError(r)) return;
    expect(r.error).toBe("invalid_argument");
    expect(r.message).toContain("Unknown field(s): unknown_field");
    expect(r.detail).toContain("Recognised fields:");
  });

  it("projects only requested fields with correct values", async () => {
    const r = await getTracks(qp, { ids: [1, 2], fields: ["id", "artist", "title"] });
    expect(isEngineError(r)).toBe(false);
    if (isEngineError(r)) return;
    expect(r.tracks.length).toBe(2);
    for (const track of r.tracks) {
      expect(Object.keys(track)).toEqual(["id", "artist", "title"]);
      expect(track.id).toBeDefined();
      expect(track.artist).toBeDefined();
      expect(track.title).toBeDefined();
    }
  });
});

describe("list_libraries", () => {
  it("lists a supported library with correct metadata", () => {
    const dir = mkdtempSync(join(tmpdir(), "edj-lib-supported-"));
    const mdb = makeLibrary(dir, { tracks: 50, schema: [3, 0, 2] });
    const lib = readLibraryInfo(mdb);
    if (isEngineError(lib)) throw new Error("fixture library unreadable");

    const result = listLibraries(new Map(), [lib]);
    expect(result.libraries.length).toBe(1);
    expect(result.libraries[0]!.path).toBe(lib.path);
    expect(result.libraries[0]!.uuid).toBe(lib.uuid);
    expect(result.libraries[0]!.schema).toBe("3.0.2");
    expect(result.libraries[0]!.supported).toBe(true);
    expect(result.libraries[0]!.track_count).toBe(50);
    expect(result.libraries[0]!.index_generation).toBeNull();
    expect(result.supported_schemas).toContain("3.0.0");
    expect(result.supported_schemas).toContain("3.0.2");
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists an unsupported schema library as unsupported, not hidden", () => {
    const dir = mkdtempSync(join(tmpdir(), "edj-lib-unsupported-"));
    const mdb = makeLibrary(dir, { tracks: 30, schema: [1, 0, 0] });
    const lib = readLibraryInfo(mdb);
    if (isEngineError(lib)) throw new Error("fixture library unreadable");

    const result = listLibraries(new Map(), [lib]);
    expect(result.libraries.length).toBe(1);
    expect(result.libraries[0]!.schema).toBe("1.0.0");
    expect(result.libraries[0]!.supported).toBe(false);
    // Unsupported schema can still have track count if Track table exists
    expect(result.libraries[0]!.track_count).toBe(30);
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns empty list when no libraries are passed", () => {
    const result = listLibraries(new Map(), []);
    expect(result.libraries).toEqual([]);
    expect(result.supported_schemas.length).toBeGreaterThan(0);
  });

  it("reports index generation from the generations map", () => {
    const dir = mkdtempSync(join(tmpdir(), "edj-lib-gen-"));
    const mdb = makeLibrary(dir, { tracks: 50 });
    const lib = readLibraryInfo(mdb);
    if (isEngineError(lib)) throw new Error("fixture library unreadable");

    const generations = new Map<string, number>([["uuid1", 5]]);
    const result = listLibraries(generations, [lib]);
    // Only the matching uuid gets the generation; others get null
    expect(result.libraries[0]!.index_generation).toBeNull();

    const genMatch = new Map<string, number>([[lib.uuid, 42]]);
    const result2 = listLibraries(genMatch, [lib]);
    expect(result2.libraries[0]!.index_generation).toBe(42);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("refresh_index", () => {
  it("reports a no-op when the library has not changed", async () => {
    const r = await refreshIndex(mgr);
    expect(isEngineError(r)).toBe(false);
    if (isEngineError(r)) return;
    expect(r.rebuilt).toBe(false);
    expect(r.indexed).toBeNull();
  });

  it("rebuilds and indexes when the library changes, preserving order", async () => {
    // Create a separate test library
    const dir2 = mkdtempSync(join(tmpdir(), "edj-refresh-"));
    const mdb2 = makeLibrary(dir2, { tracks: 25 });
    const lib2 = readLibraryInfo(mdb2);
    if (isEngineError(lib2)) throw new Error("fixture library unreadable");
    const qp2 = new QueryProcess(mdb2, null, 5000);
    const mgr2 = new IndexManager(lib2, qp2, join(dir2, "sidecars"));

    // First refresh builds the index
    const r1 = await refreshIndex(mgr2);
    expect(isEngineError(r1)).toBe(false);
    if (isEngineError(r1)) return;
    expect(r1.rebuilt).toBe(true);
    expect(typeof r1.indexed).toBe("number");
    expect(r1.indexed).toBe(25);
    const gen1 = r1.generation;

    // Second refresh on unchanged library is a no-op
    const r2 = await refreshIndex(mgr2);
    expect(isEngineError(r2)).toBe(false);
    if (isEngineError(r2)) return;
    expect(r2.rebuilt).toBe(false);
    expect(r2.indexed).toBeNull();
    expect(r2.generation).toBe(gen1);

    // Mutate the library by adding a track
    {
      const raw = new DatabaseSync(mdb2);
      raw.exec("PRAGMA busy_timeout=3000");
      raw.prepare(`INSERT INTO Track (id, length, bpm, year, path, filename, bitrate, bpmAnalyzed,
        fileBytes, title, artist, album, genre, rating, fileType, isAnalyzed, dateAdded, isAvailable,
        originDatabaseUuid, originTrackId)
        VALUES (999, 180, 12000, 2025, '../Music/lib/new.mp3', 'new.mp3', 320, 120,
        8000000, 'New Track', 'Test Artist', 'New Album', 'Techno', 0, 'mp3', 1, ?, 1, ?, 999)`).run(
          Math.floor(Date.now() / 1000),
          lib2.uuid,
        );
      raw.close();
    }

    // Third refresh sees the change and rebuilds
    const r3 = await refreshIndex(mgr2);
    expect(isEngineError(r3)).toBe(false);
    if (isEngineError(r3)) return;
    expect(r3.rebuilt).toBe(true);
    expect(typeof r3.indexed).toBe("number");
    expect(r3.indexed).toBe(26);
    expect(r3.generation).toBe(gen1 + 1);

    qp2.dispose();
    rmSync(dir2, { recursive: true, force: true });
  });
});
