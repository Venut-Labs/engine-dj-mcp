// src/proc/query-client.ts
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, sep } from "node:path";
import { err, type EngineError } from "../errors.js";
import { hasHotJournal } from "../store/connections.js";

/**
 * Tests run against src/ under vitest, whose TypeScript transform does not
 * rewrite import specifiers — a forked query-worker.ts could never resolve
 * its own "../store/connections.js" import, since only connections.ts exists
 * under src/. package.json's pretest always runs `npm run build` first, so
 * the compiled worker exists at dist/proc/query-worker.js; resolve to that
 * compiled file from either location rather than forking TypeScript source.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = HERE.includes(`${sep}src${sep}proc`)
  ? join(HERE, "..", "..", "dist", "proc", "query-worker.js")
  : join(HERE, "query-worker.js");

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
}

/** Counterpart to encodeValue in the worker: rebuild BLOBs framed as base64. */
function decodeValue(v: unknown): unknown {
  if (v && typeof v === "object" && typeof (v as any).__blob === "string") {
    return Buffer.from((v as any).__blob, "base64");
  }
  return v;
}

/**
 * Runs every library query in a child process. node:sqlite exposes no
 * interrupt() and DatabaseSync blocks the event loop; worker.terminate()
 * waits for the synchronous native call to return, so a killable process is
 * the only timeout that actually works. It also isolates a crash in the
 * experimental node:sqlite binding from the MCP server itself.
 */
export class QueryProcess {
  #child: ChildProcess | null = null;
  #ready: Promise<ChildProcess> | null = null;
  #seq = 0;

  constructor(
    private readonly mdbPath: string,
    private sidecar: string | null,
    private readonly timeoutMs = 10_000,
  ) {}

  #spawn(): Promise<ChildProcess> {
    const child = fork(WORKER, [this.mdbPath, this.sidecar ?? "-"], {
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
    this.#child = child;
    child.once("exit", () => {
      if (this.#child === child) {
        this.#child = null;
        this.#ready = null;
      }
    });
    return new Promise((resolve, reject) => {
      const onMessage = (m: any) => {
        cleanup();
        if (m && m.ready === false) reject(new Error(m.message ?? "query worker failed to start"));
        else resolve(child);
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        cleanup();
        reject(new Error(`query worker exited before it was ready (code=${code}, signal=${signal})`));
      };
      const onError = (e: Error) => {
        cleanup();
        reject(e);
      };
      const cleanup = () => {
        child.off("message", onMessage);
        child.off("exit", onExit);
        child.off("error", onError);
      };
      child.once("message", onMessage);
      child.once("exit", onExit);
      child.once("error", onError);
    });
  }

  /**
   * Memoizes the in-flight spawn: the promise is stored before anything is
   * awaited, so concurrent run() calls that both observe no live child await
   * the same spawn instead of each forking (and leaking) their own child.
   */
  async #ensure(): Promise<ChildProcess> {
    if (!this.#ready) this.#ready = this.#spawn();
    try {
      return await this.#ready;
    } catch (e) {
      this.#ready = null;
      this.#child = null;
      throw e;
    }
  }

  #kill(): void {
    this.#child?.kill("SIGKILL");
    this.#child = null;
    this.#ready = null;
  }

  async #send(payload: Record<string, unknown>): Promise<any | EngineError> {
    let child: ChildProcess;
    try {
      child = await this.#ensure();
    } catch (e) {
      // openQueryConnection throws only a message for a hot journal; re-derive
      // the condition from disk rather than string-matching that message.
      if (hasHotJournal(this.mdbPath)) {
        return err(
          "library_needs_recovery",
          "The Engine library was closed uncleanly and has an unrecovered journal. " +
            "Launch Engine DJ once so it can recover the library, then retry.",
        );
      }
      return err("query_process_crashed", "Could not start the query process", { detail: String(e) });
    }
    const id = ++this.#seq;
    return new Promise((resolve) => {
      const onMessage = (m: any) => {
        if (m?.id === id) {
          cleanup();
          resolve(m);
        }
      };
      const onExit = () => {
        cleanup();
        resolve(err("query_process_crashed", "The query process exited; it has been restarted"));
      };
      const timer = setTimeout(() => {
        cleanup();
        this.#kill();
        resolve(err("query_timeout", `Query exceeded ${this.timeoutMs} ms and was terminated`));
      }, this.timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        child.off("message", onMessage);
        child.off("exit", onExit);
      };
      child.on("message", onMessage);
      child.once("exit", onExit);
      child.send({ id, ...payload });
    });
  }

  async run(sql: string, params: unknown[] = []): Promise<QueryResult | EngineError> {
    const m = await this.#send({ kind: "query", sql, params });
    if ("error" in m) return m as EngineError;
    if (!m.ok) {
      return /database is locked|busy/i.test(m.message)
        ? err("library_busy", "Engine DJ is writing to the library right now", { retry_after_ms: 5000 })
        : err("invalid_argument", "The SQL query failed", { detail: m.message });
    }
    return { columns: m.columns, rows: m.rows.map((row: unknown[]) => row.map(decodeValue)) };
  }

  /**
   * True when an index is actually ATTACHed as `side` on the live
   * connection. Every tool's SQL joins `side.track_derived`, so a caller
   * that ignores this and queries anyway gets a raw SQLite
   * "no such table: side.track_derived" rather than a structured error --
   * which is precisely what happened on a first run against a busy library.
   */
  get hasSidecar(): boolean {
    return this.sidecar !== null;
  }

  /**
   * Returns whether the attach actually took. A sidecar that cannot be
   * attached (missing, corrupt, unreadable) must not leave `hasSidecar`
   * claiming an index is available, and must not be handed to the next
   * #spawn as an argv the worker would then fail to open.
   */
  async setSidecar(path: string): Promise<boolean> {
    this.sidecar = path;
    const m = await this.#send({ kind: "sidecar", path });
    const ok = !("error" in m) && m?.ok === true;
    if (!ok) this.sidecar = null;
    return ok;
  }

  dispose(): void {
    this.#kill();
  }
}
