// tests/server.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fork } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { makeLibrary } from "./fixtures/gen-library.js";
import { QueryProcess } from "../src/proc/query-client.js";
import { runSql } from "../src/tools/sql.js";
import { createServer, findHotJournalCandidate } from "../src/server.js";
import { isEngineError } from "../src/errors.js";

const hotWriterScript = fileURLToPath(new URL("./fixtures/hot-journal-writer.js", import.meta.url));

/**
 * Same technique as query-process.test.ts and readonly-guarantees.test.ts:
 * force a real journal spill via a capped page cache, then SIGKILL the
 * writer once it signals readiness, leaving a genuinely hot journal (not a
 * synthetic one) on disk.
 */
async function makeHotJournalLibrary(): Promise<{ dir: string; mdb: string }> {
  const dir = mkdtempSync(join(tmpdir(), "edj-srv-hot-"));
  const mdb = makeLibrary(dir, { tracks: 50_000 });
  await new Promise<void>((resolve, reject) => {
    const child = fork(hotWriterScript, [mdb]);
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
  if (!existsSync(`${mdb}-journal`)) throw new Error("fixture did not leave a hot journal");
  return { dir, mdb };
}

let dir: string, qp: QueryProcess;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "edj-sql-"));
  qp = new QueryProcess(makeLibrary(dir, { tracks: 100 }), null, 5000);
});
afterAll(() => {
  qp.dispose();
  rmSync(dir, { recursive: true, force: true });
});

describe("run_sql", () => {
  it("runs a read query", async () => {
    const r = await runSql(qp, { sql: "SELECT COUNT(*) AS c FROM Track" });
    expect(isEngineError(r)).toBe(false);
    if (isEngineError(r)) return;
    expect(r.rows[0]![0]).toBe(100);
  });

  it("blocks VACUUM INTO, which the kernel would otherwise allow", async () => {
    const r = await runSql(qp, { sql: `VACUUM INTO '${join(dir, "exfil.db")}'` });
    expect(isEngineError(r)).toBe(true);
    expect(existsSync(join(dir, "exfil.db"))).toBe(false);
  });

  it("blocks a chained statement", async () => {
    const r = await runSql(qp, { sql: "SELECT 1; ATTACH DATABASE '/tmp/x.db' AS rw" });
    expect(isEngineError(r)).toBe(true);
  });

  it("injects a LIMIT and reports truncation", async () => {
    const r = await runSql(qp, { sql: "SELECT id FROM Track", limit: 5 });
    expect(isEngineError(r)).toBe(false);
    if (isEngineError(r)) return;
    expect(r.rows.length).toBe(5);
    expect(r.truncated).toBe(true);
  });
});

describe("run_sql and a zero-row result", () => {
  it("still reports real column names, not an empty array", async () => {
    // id -1 cannot exist (the fixture generates positive autoincrement ids),
    // so this genuinely matches nothing rather than happening to be empty.
    const r = await runSql(qp, { sql: "SELECT id, title AS heading FROM Track WHERE id = -1" });
    expect(isEngineError(r)).toBe(false);
    if (isEngineError(r)) return;
    expect(r.rows).toEqual([]);
    // Deriving columns from rows[0] (the old behaviour) would report [] here
    // -- indistinguishable from "the query itself was malformed". Asserting
    // the alias survives also rules out a fix that just hard-codes the raw
    // column name.
    expect(r.columns).toEqual(["id", "heading"]);
  });
});

describe("run_sql and a hot journal", () => {
  it(
    "surfaces library_needs_recovery instead of a generic query failure",
    async () => {
      const { dir: hotDir, mdb: hotMdb } = await makeHotJournalLibrary();
      const hotQp = new QueryProcess(hotMdb, null, 5000);
      try {
        const r = await runSql(hotQp, { sql: "SELECT 1" });
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

describe("findHotJournalCandidate", () => {
  it("returns null when no root holds a library at all", () => {
    const empty = mkdtempSync(join(tmpdir(), "edj-empty-"));
    expect(findHotJournalCandidate([empty])).toBeNull();
    rmSync(empty, { recursive: true, force: true });
  });

  it("returns null when the library is healthy", () => {
    expect(findHotJournalCandidate([dir])).toBeNull();
  });

  it(
    "finds the hot journal that discoverLibraries() silently drops",
    async () => {
      const { dir: hotDir, mdb: hotMdb } = await makeHotJournalLibrary();
      try {
        expect(findHotJournalCandidate([hotDir])).toBe(hotMdb);
      } finally {
        rmSync(hotDir, { recursive: true, force: true });
      }
    },
    20_000,
  );
});

/**
 * Wires a real createServer() to a real MCP Client over an in-process
 * transport pair, so these tests exercise the exact request path a stdio
 * client would use -- registration, annotations, the ready() gate, and the
 * resource/tool bodies -- rather than calling the tool functions directly.
 *
 * sidecarBaseDir is required (not left to createServer()'s real default of
 * ~/.engine-dj-mcp) so a test run never leaves index files behind in the
 * developer's actual home directory; callers point it inside their own
 * temp dir so cleanup is a single rmSync.
 */
async function connectedClient(roots: string[], sidecarBaseDir: string) {
  const server = await createServer({ roots, sidecarBaseDir });
  const client = new Client({ name: "test-client", version: "0" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
}

describe("createServer", () => {
  let libDir: string, libMdb: string, libSidecars: string;
  beforeAll(() => {
    libDir = mkdtempSync(join(tmpdir(), "edj-srv-lib-"));
    libMdb = makeLibrary(libDir, { tracks: 40 });
    libSidecars = join(libDir, "sidecars");
  });
  afterAll(() => rmSync(libDir, { recursive: true, force: true }));

  it("registers all seven read-only tools", async () => {
    const { client } = await connectedClient([libDir], libSidecars);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "audit_library",
        "get_track_performance",
        "get_tracks",
        "list_libraries",
        "refresh_index",
        "run_sql",
        "search_tracks",
      ].sort(),
    );
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint, `${tool.name} must be readOnlyHint`).toBe(true);
    }
    await client.close();
  });

  it("documents the total_capped/1000 behaviour on search_tracks, not just in code", async () => {
    const { client } = await connectedClient([libDir], libSidecars);
    const { tools } = await client.listTools();
    const search = tools.find((t) => t.name === "search_tracks")!;
    expect(search.description).toMatch(/1000/);
    expect(search.description).toMatch(/total_capped/);
    await client.close();
  });

  it("exposes engine://schema without the stale bpm*100 claim, and states the camelot mapping as fact", async () => {
    const { client } = await connectedClient([libDir], libSidecars);
    const { contents } = await client.readResource({ uri: "engine://schema" });
    const text = String((contents[0] as { text: string }).text);
    expect(text).not.toMatch(/bpm\s*\/\s*100/);
    expect(text).not.toMatch(/times\s*100/i);
    expect(text).toMatch(/bpmAnalyzed/);
    expect(text).toMatch(/6B/);
    await client.close();
  });

  it("reports a real index_generation once an index has been built, through both the resource and the tool", async () => {
    const { client } = await connectedClient([libDir], libSidecars);
    // Force a build via the gated path, same as any other tool would.
    const search = await client.callTool({ name: "search_tracks", arguments: { limit: 1 } });
    expect(search.isError).toBeFalsy();

    const listed = await client.callTool({ name: "list_libraries", arguments: {} });
    const body = listed.structuredContent as any;
    const entry = body.libraries.find((l: any) => l.path === libMdb);
    expect(entry).toBeDefined();
    expect(entry.index_generation).toBeGreaterThanOrEqual(1);

    const resource = await client.readResource({ uri: "engine://libraries" });
    const resBody = JSON.parse(String((resource.contents[0] as { text: string }).text));
    const resEntry = resBody.libraries.find((l: any) => l.path === libMdb);
    expect(resEntry.index_generation).toBe(entry.index_generation);
    await client.close();
  });

  it("reports index_generation as null, not 0, when the index could not be built at all", async () => {
    // A base directory made unwritable stands in for a permissions failure
    // or a full disk (same technique as index-manager.test.ts): ensureFresh
    // cannot create the sidecar directory, so mgr.generation stays at its
    // initial 0. A generations map that included that unconditionally would
    // report index_generation: 0 here -- a real-looking number for a index
    // that was never built -- instead of null.
    const roRoot = mkdtempSync(join(tmpdir(), "edj-srv-ro-"));
    const noBuildDir = mkdtempSync(join(tmpdir(), "edj-srv-ro-lib-"));
    const noBuildMdb = makeLibrary(noBuildDir, { tracks: 5 });
    chmodSync(roRoot, 0o500); // read + execute only: no write, so no sidecar subdir can be created
    try {
      const { client } = await connectedClient([noBuildDir], join(roRoot, "sidecars"));
      const listed = await client.callTool({ name: "list_libraries", arguments: {} });
      const body = listed.structuredContent as any;
      const entry = body.libraries.find((l: any) => l.path === noBuildMdb);
      expect(entry).toBeDefined();
      expect(entry.index_generation).toBeNull();
      await client.close();
    } finally {
      chmodSync(roRoot, 0o700);
      rmSync(roRoot, { recursive: true, force: true });
      rmSync(noBuildDir, { recursive: true, force: true });
    }
  });

  it("returns library_not_found when nothing was discovered at all", async () => {
    const empty = mkdtempSync(join(tmpdir(), "edj-srv-empty-"));
    const { client } = await connectedClient([empty], join(empty, "sidecars"));
    const r = await client.callTool({ name: "run_sql", arguments: { sql: "SELECT 1" } });
    expect(r.isError).toBe(true);
    expect((r.structuredContent as any).error).toBe("library_not_found");
    await client.close();
    rmSync(empty, { recursive: true, force: true });
  });

  it("returns library_needs_recovery instead of library_not_found when the only library has a hot journal", async () => {
    const { dir: hotDir, mdb: hotMdb } = await makeHotJournalLibrary();
    void hotMdb;
    try {
      const { client } = await connectedClient([hotDir], join(hotDir, "sidecars"));
      const r = await client.callTool({ name: "run_sql", arguments: { sql: "SELECT 1" } });
      expect(r.isError).toBe(true);
      const body = r.structuredContent as any;
      expect(body.error).toBe("library_needs_recovery");
      expect(body.message).toMatch(/launch engine dj/i);

      // refresh_index has its own "no mgr" branch, separate from ready();
      // it must not be the one call site that still flattens this to
      // library_not_found.
      const refreshed = await client.callTool({ name: "refresh_index", arguments: {} });
      expect(refreshed.isError).toBe(true);
      expect((refreshed.structuredContent as any).error).toBe("library_needs_recovery");

      await client.close();
    } finally {
      rmSync(hotDir, { recursive: true, force: true });
    }
  }, 20_000);

  it("reports unsupported_schema, not library_not_found, when the only library's schema is too old", async () => {
    const oldDir = mkdtempSync(join(tmpdir(), "edj-srv-old-"));
    makeLibrary(oldDir, { tracks: 10, schema: [2, 18, 0] });
    const { client } = await connectedClient([oldDir], join(oldDir, "sidecars"));
    const r = await client.callTool({ name: "run_sql", arguments: { sql: "SELECT 1" } });
    expect(r.isError).toBe(true);
    expect((r.structuredContent as any).error).toBe("unsupported_schema");
    await client.close();
    rmSync(oldDir, { recursive: true, force: true });
  });
});
