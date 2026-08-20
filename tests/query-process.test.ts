// tests/query-process.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fork } from "node:child_process";
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
