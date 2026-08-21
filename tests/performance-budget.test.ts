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

/**
 * Budgets, and what was actually measured while designing (see
 * task-17-brief.md), at 50k synthetic tracks:
 *  - staleness probe: ~0.03 ms (a direct file read) -> 1 ms budget.
 *  - full rebuild: ~104 ms (same-process, no IPC) -> 300 ms budget (~2.9x).
 *  - search page: ~0.2 ms for the raw SQL query alone -> 25 ms budget.
 *
 * The search-page number is not directly comparable to its budget the way
 * the other two are: 0.2 ms is in-process query execution time, while this
 * test (like every real call) measures the full round trip through
 * QueryProcess's forked worker -- fork/IPC/serialization overhead, not just
 * SQL. On the machine this was last measured on, that full round trip runs
 * ~8 ms, still comfortably under 25 ms. Treat the 25 ms budget as the real
 * contract; do not read "8 ms vs 0.2 ms" as 40x regression, since the two
 * numbers measure different things.
 */
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
