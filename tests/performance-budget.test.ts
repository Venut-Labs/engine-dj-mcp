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
import { getTrackPerformance } from "../src/tools/performance.js";
import { auditLibrary, AUDIT_CHECKS } from "../src/tools/audit.js";
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
 *
 * Two later budgets, added with the tools they cover:
 *  - get_track_performance: 25 ms. It decodes blobs in the MCP process
 *    rather than the killable child, and truncates its response, so it needs
 *    a number of its own rather than riding on search's.
 *  - audit_library (the nine SQL checks; missing_files is excluded because
 *    it stats every file and is legitimately disk-bound): 500 ms. This one
 *    used to ship every offending row over IPC, so its cost grew with the
 *    library; the budget is what makes a regression back to that visible.
 *
 * Each budget prints what it actually measured, because a pass/fail alone
 * hides the margin: a drift from "8 ms against a 25 ms budget" to "24 ms
 * against a 25 ms budget" reads identically until the day it breaks. Run
 * with `--disable-console-intercept` to see the numbers on a passing run;
 * they are in the assertion messages either way. Measured 2026-08-21:
 * probe 0.01 ms, rebuild 134 ms, search page 8.18 ms,
 * get_track_performance 0.33 ms, audit 195.53 ms.
 */
function report(label: string, measured: number, budget: number): void {
  const line = `[budget] ${label}: ${measured.toFixed(2)} ms (budget ${budget} ms, ${(
    (measured / budget) *
    100
  ).toFixed(0)}% used)`;
  console.log(line);
}

describe(`performance budgets at ${N} tracks`, () => {
  it("probes staleness in under 1 ms", () => {
    const t = performance.now();
    for (let i = 0; i < 10; i++) readChangeCounter(mdb);
    const measured = (performance.now() - t) / 10;
    report("staleness probe", measured, 1);
    expect(measured, `staleness probe took ${measured.toFixed(3)} ms`).toBeLessThan(1);
  });

  it("rebuilds the whole index in under 300 ms", () => {
    const r = buildSidecar({
      mdbPath: mdb, outPath: join(dir, "budget.db"), uuid: "u", schema: "3.0.2",
    });
    expect(r.indexed).toBe(N);
    report("full rebuild", r.elapsed_ms, 300);
    expect(r.elapsed_ms, `rebuild took ${r.elapsed_ms} ms`).toBeLessThan(300);
  }, 60_000);

  it("returns a search page in under 25 ms", async () => {
    await searchTracks(qp, { q: "dark", limit: 25 }); // warm the process
    const t = performance.now();
    const r = await searchTracks(qp, { q: "dark", bpm: { around: 124, tolerance_pct: 3 }, limit: 25 });
    const elapsed = performance.now() - t;
    expect(isEngineError(r)).toBe(false);
    report("search page (full round trip)", elapsed, 25);
    expect(elapsed, `search page took ${elapsed.toFixed(2)} ms`).toBeLessThan(25);
  }, 30_000);

  it("returns get_track_performance in under 25 ms, bounded regardless of item count", async () => {
    // New budget: this tool decodes blobs in the MCP process rather than the
    // query child, and now truncates its response, so it needs a number of
    // its own rather than being covered by search's.
    await getTrackPerformance(qp, { id: 1 }); // warm
    const t = performance.now();
    const r = await getTrackPerformance(qp, { id: 1 });
    const elapsed = performance.now() - t;
    expect(isEngineError(r)).toBe(false);
    report("get_track_performance", elapsed, 25);
    expect(elapsed, `get_track_performance took ${elapsed.toFixed(2)} ms`).toBeLessThan(25);
  }, 30_000);

  it("audits the whole collection in under 500 ms, now that counting is server side", async () => {
    // Was O(offending rows) over IPC; this budget is what makes a regression
    // back to that visible at 50k tracks. missing_files is excluded because
    // it stats every file and is legitimately disk-bound.
    const checks = AUDIT_CHECKS.filter((c) => c !== "missing_files");
    const t = performance.now();
    const r = await auditLibrary(qp, mdb, { checks: [...checks] });
    const elapsed = performance.now() - t;
    expect(isEngineError(r)).toBe(false);
    report("audit_library (9 SQL checks)", elapsed, 500);
    expect(elapsed, `audit took ${elapsed.toFixed(2)} ms`).toBeLessThan(500);
  }, 60_000);
});
