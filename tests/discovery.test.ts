import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, readdirSync, mkdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { makeLibrary } from "./fixtures/gen-library.js";
import { readLibraryInfo, discoverLibraries, defaultRoots } from "../src/discovery.js";
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

  it("opens a library whose folder name contains a hash, an apostrophe and spaces", () => {
    // readLibraryInfo used to hand-build `file:<path>?mode=ro`, and SQLite's
    // URI syntax cuts a filename at `#`. The result was not an error a user
    // could act on: discoverLibraries drops any candidate that fails to
    // read, so the whole library vanished and the server reported
    // library_not_found -- while openQueryConnection, which escapes
    // properly, opened the very same file without complaint.
    const oddRoot = mkdtempSync(join(tmpdir(), "edj-odd-"));
    try {
      const oddDir = join(oddRoot, "Rock 'n' Roll #1 Mix");
      mkdirSync(oddDir, { recursive: true });
      const oddMdb = makeLibrary(oddDir, { tracks: 7 });
      expect(oddMdb).toContain("#");

      const info = readLibraryInfo(oddMdb);
      expect(isEngineError(info), JSON.stringify(info)).toBe(false);
      if (isEngineError(info)) return;
      expect(info.trackCount).toBe(7);
      expect(info.supported).toBe(true);

      const found = discoverLibraries([oddDir]);
      expect(found.map((l) => l.path)).toEqual([oddMdb]);
    } finally {
      rmSync(oddRoot, { recursive: true, force: true });
    }
  });
});

describe("defaultRoots", () => {
  // Every other test in this suite passes explicit roots, so nothing else
  // would notice defaultRoots() regressing to an empty (or otherwise inert)
  // list -- which would silently disable both discoverLibraries()'s own
  // default lookup and server.ts's hot-journal fallback that reuses this
  // same function. Assert the real value, not just that it returns.
  it("includes the real home Music directory", () => {
    expect(defaultRoots()).toContain(join(homedir(), "Music"));
  });

  it("includes every real /Volumes mount, when /Volumes exists", () => {
    let volumes: string[] = [];
    try {
      volumes = readdirSync("/Volumes");
    } catch {
      return; // /Volumes does not exist off macOS; nothing to assert here
    }
    const roots = defaultRoots();
    for (const vol of volumes) expect(roots).toContain(join("/Volumes", vol));
  });
});
