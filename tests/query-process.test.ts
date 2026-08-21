// tests/query-process.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fork, execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { makeLibrary } from "./fixtures/gen-library.js";
import { QueryProcess } from "../src/proc/query-client.js";
import { isEngineError } from "../src/errors.js";

const hotWriterScript = fileURLToPath(new URL("./fixtures/hot-journal-writer.js", import.meta.url));

let dir: string, mdb: string, qp: QueryProcess;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "edj-proc-"));
  mdb = makeLibrary(dir, { tracks: 20000 });
  qp = new QueryProcess(mdb, null, 800);
});
afterAll(() => {
  qp.dispose();
  rmSync(dir, { recursive: true, force: true });
});

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

  it("carries the query plan in detail when it kills a query", async () => {
    // "exceeded 800 ms" tells a model nothing it can act on; the plan does.
    // EXPLAIN QUERY PLAN costs ~0.02 ms because it executes nothing, so
    // fetching it after the kill cannot itself hang.
    const r = await qp.run(
      "SELECT COUNT(*) FROM Track x JOIN Track y ON x.bpm = y.bpm JOIN Track z ON z.bpm = x.bpm",
    );
    expect(isEngineError(r)).toBe(true);
    if (!isEngineError(r)) return;
    expect(r.error).toBe("query_timeout");
    expect(r.detail, "query_timeout must carry the plan").toBeTruthy();
    // A real plan names each source it walks and how it walks it (SQLite
    // reports the alias, so `x`/`y`/`z` rather than `Track`), one step per
    // line. A placeholder or an echo of the SQL would satisfy "truthy" but
    // not this.
    expect(r.detail).toMatch(/SCAN/);
    expect(r.detail).toMatch(/\bx\b/);
    expect(r.detail!.split("; ").length).toBeGreaterThan(1);
    expect(r.detail).not.toContain("SELECT COUNT(*)");

    // The process must still be usable after the extra EXPLAIN round trip.
    expect(isEngineError(await qp.run("SELECT COUNT(*) AS c FROM Track"))).toBe(false);
  }, 20_000);

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

describe("spawn memoisation", () => {
  /** Live query-worker child processes serving a specific library file. */
  function workerPids(mdbPath: string): number[] {
    return execFileSync("ps", ["-eo", "pid=,args=", "-ww"], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    })
      .split("\n")
      .filter((line) => line.includes("query-worker.js") && line.includes(mdbPath))
      .map((line) => Number(line.trim().split(/\s+/)[0]))
      .filter((pid) => Number.isFinite(pid));
  }

  it("forks exactly one child for concurrent first calls, not one per call", async () => {
    // #ensure stores the spawn promise before awaiting anything, so several
    // run() calls that all see no live child share one fork. Nothing else
    // in the suite would notice that memoisation regressing: every call
    // would still return the right answer, while leaking a child process
    // per concurrent call, silently. A fresh library file per test makes
    // the process count exact regardless of what else is running.
    const ownDir = mkdtempSync(join(tmpdir(), "edj-proc-single-"));
    try {
      const ownMdb = makeLibrary(ownDir, { tracks: 20 });
      expect(workerPids(ownMdb)).toEqual([]);

      const own = new QueryProcess(ownMdb, null, 10_000);
      try {
        // Fired together, before any of them can have finished spawning.
        const results = await Promise.all(
          Array.from({ length: 8 }, () => own.run("SELECT COUNT(*) AS c FROM Track")),
        );
        for (const r of results) {
          expect(isEngineError(r), JSON.stringify(r)).toBe(false);
          if (isEngineError(r)) return;
          expect(Number(r.rows[0]![0])).toBe(20);
        }
        expect(workerPids(ownMdb).length).toBe(1);
      } finally {
        own.dispose();
      }
    } finally {
      rmSync(ownDir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("library_busy retries", () => {
  // The shared qp above has an 800 ms query timeout, well under SQLite's own
  // 3 s busy_timeout, so a locked query there would come back as
  // query_timeout and never reach the retry path at all.
  let busyQp: QueryProcess;
  beforeAll(async () => {
    busyQp = new QueryProcess(mdb, null, 30_000);
    await busyQp.run("SELECT 1"); // spawn the worker before the lock exists
  });
  afterAll(() => busyQp.dispose());

  it(
    "answers after the writer commits, instead of refusing on the first lock",
    async () => {
      // Held for 3.5 s: longer than one busy_timeout (so the first attempt
      // genuinely fails and the old single-attempt code would have returned
      // library_busy here), shorter than two (so a retry succeeds). Engine's
      // real write transactions behave exactly like this.
      const holder = new DatabaseSync(mdb);
      holder.exec("BEGIN EXCLUSIVE");
      holder.exec("UPDATE Track SET rating = 4 WHERE id = 1");
      const release = setTimeout(() => {
        holder.exec("ROLLBACK");
        holder.close();
      }, 3_500);

      try {
        const started = Date.now();
        const r = await busyQp.run("SELECT COUNT(*) AS c FROM Track");
        const elapsed = Date.now() - started;
        expect(isEngineError(r), JSON.stringify(r)).toBe(false);
        if (isEngineError(r)) return;
        expect(Number(r.rows[0]![0])).toBe(20000);
        // It cannot have answered before the lock was released, so this
        // really did survive a lock rather than never meeting one.
        expect(elapsed).toBeGreaterThan(3_000);
      } finally {
        clearTimeout(release);
      }
    },
    60_000,
  );

  it(
    "gives up after a bounded number of attempts rather than hanging",
    async () => {
      const holder = new DatabaseSync(mdb);
      holder.exec("BEGIN EXCLUSIVE");
      holder.exec("UPDATE Track SET rating = 5 WHERE id = 2");
      try {
        const started = Date.now();
        const r = await busyQp.run("SELECT COUNT(*) AS c FROM Track");
        const elapsed = Date.now() - started;
        expect(isEngineError(r)).toBe(true);
        if (!isEngineError(r)) return;
        expect(r.error).toBe("library_busy");
        expect(r.retry_after_ms).toBe(5000);
        // Three attempts at a 3 s busy_timeout each: comfortably more than
        // one attempt's worth of waiting (which would be ~3 s), and finite.
        expect(elapsed).toBeGreaterThan(8_000);
        expect(elapsed).toBeLessThan(30_000);
      } finally {
        holder.exec("ROLLBACK");
        holder.close();
      }
    },
    60_000,
  );
});

describe("query process and a hot journal", () => {
  it(
    "maps a worker that cannot open the library to library_needs_recovery",
    async () => {
      // Same technique as readonly-guarantees.test.ts: force a real journal
      // spill via a capped page cache, then SIGKILL the writer once it
      // signals readiness, leaving a genuinely hot journal on disk.
      const hotDir = mkdtempSync(join(tmpdir(), "edj-proc-hot-"));
      const hotMdb = makeLibrary(hotDir, { tracks: 50_000 });

      await new Promise<void>((resolve, reject) => {
        const child = fork(hotWriterScript, [hotMdb]);
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error("hot-journal-writer never signalled ready"));
        }, 15_000);
        child.on("message", () => {
          clearTimeout(timer);
          child.kill("SIGKILL");
        });
        child.on("error", (e) => {
          clearTimeout(timer);
          reject(e);
        });
        child.on("exit", () => resolve());
      });

      expect(existsSync(`${hotMdb}-journal`)).toBe(true);

      const hotQp = new QueryProcess(hotMdb, null, 5000);
      try {
        const r = await hotQp.run("SELECT 1");
        expect(isEngineError(r)).toBe(true);
        if (!isEngineError(r)) return;
        expect(r.error).toBe("library_needs_recovery");
        expect(r.message).toMatch(/launch engine dj/i);
      } finally {
        hotQp.dispose();
        rmSync(hotDir, { recursive: true, force: true });
      }
    },
    20_000,
  );
});
