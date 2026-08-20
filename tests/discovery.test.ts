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
