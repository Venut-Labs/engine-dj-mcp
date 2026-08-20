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
