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
