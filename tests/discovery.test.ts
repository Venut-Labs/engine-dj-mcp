import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
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
