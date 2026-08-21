// tests/server.test.ts
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, chmodSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fork, execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
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

let dir: string, mdb: string, qp: QueryProcess;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "edj-sql-"));
  mdb = makeLibrary(dir, { tracks: 100 });
  qp = new QueryProcess(mdb, null, 5000);
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

describe("run_sql and a caller-supplied LIMIT that would otherwise bypass the cap", () => {
  it("bounds a query whose own top-level LIMIT exceeds the tool's cap", async () => {
    // The old "append only if the scanner found no LIMIT" rule saw this
    // LIMIT and left the statement untouched, so it ran effectively
    // unbounded (limited only by the fixture's own 100 rows, not by the
    // tool's requested cap of 10).
    const r = await runSql(qp, { sql: "SELECT id FROM Track LIMIT 100000", limit: 10 });
    expect(isEngineError(r)).toBe(false);
    if (isEngineError(r)) return;
    expect(r.rows.length).toBe(10);
    expect(r.truncated).toBe(true);
  });

  it("bounds a WHERE ... IN (subquery LIMIT ...) query that fooled the old scanner", async () => {
    // The scanner has no parenthesis-depth tracking, so a LIMIT nested
    // inside a subquery reads as "the statement already has a LIMIT" --
    // even though it is the *outer* WHERE, not the inner subquery, that
    // determines how many rows actually come back. NOT IN here matches
    // 99 of the fixture's 100 tracks, so an unbounded run would return far
    // more than the requested cap of 10.
    const r = await runSql(qp, {
      sql: "SELECT * FROM Track WHERE id NOT IN (SELECT id FROM Track LIMIT 1)",
      limit: 10,
    });
    expect(isEngineError(r)).toBe(false);
    if (isEngineError(r)) return;
    expect(r.rows.length).toBe(10);
    expect(r.truncated).toBe(true);
  });

  it("still executes the exact shape from the finding correctly", async () => {
    // Literally the second example from the review finding. It happens to
    // match only 1 row regardless of bounding (id IN a one-row subquery),
    // so this is a regression check that wrapping a WHERE ... IN (...)
    // query is not itself broken -- the row-count bound is covered above.
    const r = await runSql(qp, {
      sql: "SELECT * FROM Track WHERE id IN (SELECT id FROM Track LIMIT 1)",
      limit: 10,
    });
    expect(isEngineError(r)).toBe(false);
    if (isEngineError(r)) return;
    expect(r.rows.length).toBe(1);
  });

  it("does not inflate a deliberately small inner LIMIT", async () => {
    // Wrapping must not turn "give me 3 rows" into "give me up to the
    // tool's cap" -- the inner LIMIT is genuinely smaller and must win.
    const r = await runSql(qp, { sql: "SELECT id FROM Track LIMIT 3" }); // default tool limit is 200
    expect(isEngineError(r)).toBe(false);
    if (isEngineError(r)) return;
    expect(r.rows.length).toBe(3);
    expect(r.truncated).toBe(false);
  });

  it("preserves ORDER BY through the wrap, not merely the row count", async () => {
    // enforceLimit composes "SELECT * FROM (<sql>) LIMIT n" rather than
    // appending, so the inner ORDER BY sits inside a subquery -- SQL does
    // not guarantee a subquery preserves its own ordering when it feeds an
    // outer query. fileBytes carries no index (only title, artist, album,
    // genre, key, rating, year, dateAdded, length and bpmAnalyzed do, per
    // gen-library.ts), and its values are drawn independently of both
    // insertion order and the id/rowid order SQLite would fall back to, so
    // a regression that silently dropped the ORDER BY would very likely
    // change the row sequence, not just its length. The tiebreak on id
    // makes the expectation deterministic even if two fixture rows land on
    // the same fileBytes value.
    const sql = "SELECT id, fileBytes FROM Track ORDER BY fileBytes DESC, id ASC";

    const raw = new DatabaseSync(`file:${mdb}?mode=ro`, { readOnly: true });
    let expected: [number, number][];
    try {
      expected = (raw.prepare(`${sql} LIMIT 20`).all() as { id: number; fileBytes: number }[]).map((row) => [
        Number(row.id),
        Number(row.fileBytes),
      ]);
    } finally {
      raw.close();
    }
    expect(expected.length).toBe(20);

    const r = await runSql(qp, { sql, limit: 20 });
    expect(isEngineError(r)).toBe(false);
    if (isEngineError(r)) return;
    const actual = r.rows.map((row) => [Number(row[0]), Number(row[1])]);

    expect(actual).toEqual(expected);
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
const openServers: { dispose(): void }[] = [];

async function connectedClient(roots: string[], sidecarBaseDir: string) {
  const server = await createServer({ roots, sidecarBaseDir });
  // Each createServer forks a query child; without this every test in this
  // file that only closed its client left one behind for the rest of the run.
  openServers.push(server);
  const client = new Client({ name: "test-client", version: "0" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
}

afterEach(() => {
  for (const s of openServers.splice(0)) s.dispose();
});

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

  it("says in get_track_performance's own description which layouts are validated", async () => {
    // The cue and beatgrid layouts are now confirmed against a real library;
    // the loop layout is not, because no library was available with a loop
    // saved. A model that sees neither fact either repeats unconfirmed loop
    // bounds as fact or discards confirmed cue positions as guesses, so both
    // halves have to live where the model reads them, not in a source
    // comment.
    const { client } = await connectedClient([libDir], libSidecars);
    const { tools } = await client.listTools();
    const perf = tools.find((t) => t.name === "get_track_performance")!;
    expect(perf.description).toMatch(/verified/);
    expect(perf.description).toMatch(/unverified/);
    // Which is which, not merely that both words appear.
    expect(perf.description).toMatch(/layout: "verified" \(cues, beatgrid\)/);
    expect(perf.description).toMatch(/layout: "unverified" \(loops\)/);
    expect(perf.description).toMatch(/must not be reported to a user as fact/i);
    await client.close();
  });

  it("tells a model, in engine://schema, that a quickCues blob is not a cue", async () => {
    // Engine writes the blob to every analysed track, so `quickCues IS NOT
    // NULL` answers "analysed", not "has cues" -- in the reference library
    // all 281 tracks pass that test and two actually have a cue. A model
    // writing SQL against side.track_derived.has_cues needs to know.
    const { client } = await connectedClient([libDir], libSidecars);
    const { contents } = await client.readResource({ uri: "engine://schema" });
    const text = String((contents[0] as { text: string }).text);
    expect(text).toMatch(/quickCues IS NOT NULL/);
    expect(text).toMatch(/means "analysed", not "has\s+cues"/);
    expect(text).toMatch(/get_track_performance/);
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
    // Loose matches on /bpmAnalyzed/ and /6B/ alone would still pass an
    // empty or vague BPM section -- this resource exists solely to be
    // true, so pin down the actual claim: bpm is stored at face value
    // (not scaled), backed by the measured example, not just the phrase.
    expect(text).toMatch(/stored at face\s+value/i);
    expect(text).toMatch(/102 means 102 BPM/i);
    await client.close();
  });

  it("names every registered SQL function in engine://schema, abs_path included", async () => {
    // The resource is the only place a model learns which functions exist
    // before writing run_sql against them, and abs_path was in the spec's
    // table but neither registered nor documented.
    const { client } = await connectedClient([libDir], libSidecars);
    const { contents } = await client.readResource({ uri: "engine://schema" });
    const text = String((contents[0] as { text: string }).text);
    for (const fn of ["camelot(key)", "key_name(key)", "tempo(bpmAnalyzed, bpm)", "key_distance(a, b)", "abs_path(path)"]) {
      expect(text, fn).toContain(fn);
    }
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

  it("redacts the library's own absolute path -- containing the account name -- in both the tool and the resource", async () => {
    // list_libraries reports the absolute location of m.db itself (not a
    // Track.path), which is routinely absolute in real use, unlike search
    // results. Rooting the fixture under $HOME, rather than the usual
    // os.tmpdir(), is required to exercise this for real: a fixture placed
    // under tmpdir (as libDir above is) never contains $HOME to begin with,
    // so any "does not contain $HOME" assertion against it would pass
    // whether or not redaction ran at all.
    const homeLibDir = mkdtempSync(join(homedir(), ".edj-mcp-srv-lib-priv-"));
    try {
      const homeLibMdb = makeLibrary(homeLibDir, { tracks: 5 });
      expect(homeLibMdb.startsWith(homedir() + "/")).toBe(true); // sanity

      const { client } = await connectedClient([homeLibDir], join(homeLibDir, "sidecars"));

      const listed = await client.callTool({ name: "list_libraries", arguments: {} });
      const toolPath = String((listed.structuredContent as any).libraries[0].path);
      expect(toolPath).not.toContain(homedir());
      // Still the same file: only the home prefix changed, not the tail --
      // a redaction that truncated or mangled the path would satisfy the
      // "not.toContain" check above but fail this one.
      expect(toolPath).toBe("~" + homeLibMdb.slice(homedir().length));

      const resource = await client.readResource({ uri: "engine://libraries" });
      const resBody = JSON.parse(String((resource.contents[0] as { text: string }).text));
      const resPath = String(resBody.libraries[0].path);
      expect(resPath).not.toContain(homedir());
      expect(resPath).toBe(toolPath);

      await client.close();
    } finally {
      rmSync(homeLibDir, { recursive: true, force: true });
    }
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

  it("re-scans in the tool but not in the resource, so a drive plugged in later is visible", async () => {
    // createServer captures discoverLibraries() once. A DJ plugging a USB
    // drive in after starting their assistant is the ordinary case, and
    // "restart it" is not an answer -- but a resource is defined as a
    // snapshot, so only the tool re-scans, and this pins both halves.
    const root = mkdtempSync(join(tmpdir(), "edj-srv-latecomer-"));
    try {
      const { client } = await connectedClient([root], join(root, "sidecars"));

      const before = await client.callTool({ name: "list_libraries", arguments: {} });
      expect((before.structuredContent as any).libraries).toEqual([]);

      // Appears only after the server was constructed.
      const lateMdb = makeLibrary(root, { tracks: 5 });

      const after = await client.callTool({ name: "list_libraries", arguments: {} });
      expect((after.structuredContent as any).libraries.map((l: any) => l.path)).toEqual([lateMdb]);

      const resource = await client.readResource({ uri: "engine://libraries" });
      const resBody = JSON.parse(String((resource.contents[0] as { text: string }).text));
      expect(resBody.libraries).toEqual([]);

      await client.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
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

  it("kills its query child on close, instead of leaking one process per server", async () => {
    // createServer forks a child and previously had no shutdown path at all,
    // so nothing -- not close(), not garbage collection -- ever released it.
    // Matching on this library's own unique temp path keeps the count exact
    // even while other suites have their own workers running.
    const ownDir = mkdtempSync(join(tmpdir(), "edj-srv-shutdown-"));
    try {
      const ownMdb = makeLibrary(ownDir, { tracks: 5 });
      expect(workerPids(ownMdb)).toEqual([]); // nothing before

      const { server, client } = await connectedClient([ownDir], join(ownDir, "sidecars"));
      const r = await client.callTool({ name: "search_tracks", arguments: { limit: 1 } });
      expect(r.isError).toBeFalsy(); // the child really is up and serving

      const alive = workerPids(ownMdb);
      // Proves the matcher works; without this the "gone afterwards"
      // assertion below would pass against a matcher that finds nothing.
      expect(alive.length).toBe(1);

      await client.close();
      await server.close();

      // SIGKILL is delivered synchronously to the parent's bookkeeping, but
      // reaping is not instant; give the OS a moment before looking.
      for (let i = 0; i < 50 && workerPids(ownMdb).length > 0; i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(workerPids(ownMdb)).toEqual([]);

      // ps stops matching a dead process's argv, so confirm the pid itself
      // is no longer a running process: either fully reaped (no ps row) or
      // a zombie (state Z), never still executing. `process.kill(pid, 0)`
      // cannot make this distinction -- it succeeds against a zombie too.
      // ps exits non-zero (and execFileSync throws) when the pid is gone
      // entirely, which is the strongest form of the outcome we want.
      let state = "";
      try {
        state = execFileSync("ps", ["-o", "stat=", "-p", String(alive[0])], {
          encoding: "utf8",
        }).trim();
      } catch {
        state = "";
      }
      expect(state === "" || state.startsWith("Z"), `pid ${alive[0]} state ${state}`).toBe(true);
    } finally {
      rmSync(ownDir, { recursive: true, force: true });
    }
  }, 30_000);

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
