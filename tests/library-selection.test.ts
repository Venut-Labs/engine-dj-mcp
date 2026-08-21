// tests/library-selection.test.ts
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { makeLibrary } from "./fixtures/gen-library.js";
import { createServer } from "../src/server.js";
import { pickDefaultLibrary, findLibrary, libraryNotFound } from "../src/library-select.js";
import type { LibraryInfo } from "../src/discovery.js";

/**
 * Two fixtures that a wrong selection cannot silently satisfy.
 *
 * The whole point of these tests is that picking the wrong library fails, so
 * the two libraries differ in every way a test could observe: a different
 * uuid, a different track count, and a marker word prefixed to every title
 * so a full-text search for one library's marker returns nothing at all from
 * the other. SMALL is deliberately listed first by root-scan order and is
 * deliberately the smaller of the two -- exactly the shape of the real
 * defect, where ~/Music (empty, first) shadowed a USB drive (257 tracks,
 * second).
 */
const SMALL = {
  tracks: 12,
  uuid: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
  marker: "ALPHAMARK",
} as const;
const LARGE = {
  tracks: 47,
  uuid: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb",
  marker: "BETAMARK",
} as const;

// ---------------------------------------------------------------------------
// Unit level: the selection rules themselves.
// ---------------------------------------------------------------------------

function info(over: Partial<LibraryInfo> & { path: string }): LibraryInfo {
  return {
    uuid: "u-" + over.path,
    schema: [3, 0, 2],
    supported: true,
    trackCount: 0,
    ...over,
  };
}

describe("pickDefaultLibrary", () => {
  it("picks the supported library holding the most tracks, not the first scanned", () => {
    const first = info({ path: "/a/m.db", trackCount: 0 });
    const second = info({ path: "/b/m.db", trackCount: 257 });
    expect(pickDefaultLibrary([first, second])).toBe(second);
    // Order must not decide it: the same two libraries the other way round
    // still select the populated one, so this cannot pass by picking "last".
    expect(pickDefaultLibrary([second, first])).toBe(second);
  });

  it("breaks a tie on root-scan order, so the choice is deterministic", () => {
    const first = info({ path: "/a/m.db", trackCount: 100 });
    const second = info({ path: "/b/m.db", trackCount: 100 });
    expect(pickDefaultLibrary([first, second])).toBe(first);
    expect(pickDefaultLibrary([second, first])).toBe(second);
  });

  it("never defaults to an unsupported library while a supported one exists", () => {
    const big = info({ path: "/old/m.db", trackCount: 9000, supported: false, schema: [2, 18, 0] });
    const small = info({ path: "/new/m.db", trackCount: 3 });
    expect(pickDefaultLibrary([big, small])).toBe(small);
  });

  it("still surfaces an unsupported library when nothing is supported", () => {
    // Returning null here would collapse into library_not_found and hide the
    // specific, actionable unsupported_schema the caller needs.
    const old = info({ path: "/old/m.db", trackCount: null, supported: false, schema: [1, 6, 0] });
    expect(pickDefaultLibrary([old])).toBe(old);
  });

  it("returns null only when there is genuinely nothing", () => {
    expect(pickDefaultLibrary([])).toBeNull();
  });

  it("prefers a known track count over an unknown one", () => {
    const unknown = info({ path: "/a/m.db", trackCount: null });
    const known = info({ path: "/b/m.db", trackCount: 0 });
    expect(pickDefaultLibrary([unknown, known])).toBe(known);
  });
});

describe("findLibrary", () => {
  const home = info({ path: join(homedir(), "Music/Engine Library/Database2/m.db") });
  const drive = info({ path: "/Volumes/DJ-USB/Engine Library/Database2/m.db" });
  const libs = [home, drive];

  it("resolves a uuid, case-insensitively and ignoring surrounding whitespace", () => {
    expect(findLibrary(libs, drive.uuid)).toBe(drive);
    expect(findLibrary(libs, `  ${drive.uuid.toUpperCase()}  `)).toBe(drive);
  });

  it("resolves an absolute path", () => {
    expect(findLibrary(libs, drive.path)).toBe(drive);
  });

  it("resolves the ~/... form that list_libraries reports", () => {
    // The tail is identical to home.path; only the prefix is folded. A test
    // against a path with no $HOME in it would pass without expandHome.
    expect(findLibrary(libs, "~" + home.path.slice(homedir().length))).toBe(home);
  });

  it("returns null for a value that matches neither", () => {
    expect(findLibrary(libs, "not-a-library")).toBeNull();
    expect(findLibrary(libs, "")).toBeNull();
  });

  it("does not match a value that merely contains a library path", () => {
    expect(findLibrary(libs, drive.path + "/nope")).toBeNull();
    expect(findLibrary(libs, dirname(drive.path))).toBeNull();
  });
});

describe("libraryNotFound", () => {
  it("names the rejected value and lists what is selectable", () => {
    const e = libraryNotFound("typo", [
      info({ path: "/a/m.db", uuid: "uuid-a" }),
      info({ path: "/b/m.db", uuid: "uuid-b" }),
    ]);
    expect(e.error).toBe("library_not_found"); // no new code in the taxonomy
    expect(e.message).toContain("typo");
    expect(e.detail).toContain("uuid-a");
    expect(e.detail).toContain("uuid-b");
  });

  it("says so plainly when nothing at all was discovered", () => {
    const e = libraryNotFound("anything", []);
    expect(e.error).toBe("library_not_found");
    expect(e.detail).toContain("list_libraries");
  });
});

// ---------------------------------------------------------------------------
// Through a real MCP client, against real fixture libraries on disk.
// ---------------------------------------------------------------------------

const openServers: { dispose(): void }[] = [];
afterEach(() => {
  for (const s of openServers.splice(0)) s.dispose();
});

let base: string;
let sidecarSeq = 0;
/** A fresh sidecar base per server, so one test's built index cannot make
 * another test's refresh report `rebuilt: false`. */
const freshSidecars = () => join(base, `sidecars-${++sidecarSeq}`);

async function connectedClient(roots: string[], sidecarBaseDir = freshSidecars()) {
  const server = await createServer({ roots, sidecarBaseDir });
  openServers.push(server);
  const client = new Client({ name: "test-client", version: "0" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
}

/** Live query-worker children serving one specific library file. */
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

type Search = { tracks: { title: string }[]; total?: number; total_capped?: boolean };

async function search(client: Client, args: Record<string, unknown>) {
  const r = await client.callTool({
    name: "search_tracks",
    arguments: { limit: 100, include_total: true, ...args },
  });
  return { isError: r.isError === true, body: r.structuredContent as unknown as Search & { error?: string; message?: string; detail?: string } };
}

describe("selecting a library", () => {
  let smallRoot: string, largeRoot: string, smallMdb: string, largeMdb: string;

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), "edj-libsel-"));
    smallRoot = join(base, "small");
    largeRoot = join(base, "large");
    mkdirSync(smallRoot);
    mkdirSync(largeRoot);
    smallMdb = makeLibrary(smallRoot, SMALL);
    largeMdb = makeLibrary(largeRoot, LARGE);

    // Only the small library's audio files actually exist on disk. That is
    // what makes audit_library's missing_files answer depend on which
    // library's mdb path the tool was handed, rather than on nothing.
    for (let i = 1; i <= SMALL.tracks; i++) {
      const file = join(smallRoot, "Music", "lib", String(i % 50), `t${i}.mp3`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "");
    }
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  /** roots in this order, so the *smaller* library is the one found first. */
  const roots = () => [smallRoot, largeRoot];

  it("fixture sanity: the smaller library really is first in scan order", async () => {
    // Everything below rests on this. Without it, "the default picked the
    // bigger one" could be satisfied by a server that simply picked the
    // first, or by two fixtures that were secretly identical.
    const { client } = await connectedClient(roots());
    const listed = await client.callTool({ name: "list_libraries", arguments: {} });
    const libs = (listed.structuredContent as any).libraries;
    expect(libs.map((l: any) => l.path)).toEqual([smallMdb, largeMdb]);
    expect(libs.map((l: any) => l.track_count)).toEqual([SMALL.tracks, LARGE.tracks]);
    expect(libs.map((l: any) => l.uuid)).toEqual([SMALL.uuid, LARGE.uuid]);
    await client.close();
  });

  it("defaults to the supported library with the most tracks, not the first found", async () => {
    const { client } = await connectedClient(roots());

    const all = await search(client, {});
    expect(all.isError).toBe(false);
    expect(all.body.total).toBe(LARGE.tracks);
    expect(all.body.tracks.every((t) => t.title.startsWith(LARGE.marker))).toBe(true);

    // Positive control on the same server: the small library's content is
    // genuinely absent, not merely unasserted.
    const alpha = await search(client, { q: SMALL.marker });
    expect(alpha.body.total).toBe(0);
    const beta = await search(client, { q: LARGE.marker });
    expect(beta.body.total).toBe(LARGE.tracks);

    await client.close();
  });

  it("selects either library by uuid", async () => {
    const { client } = await connectedClient(roots());

    const small = await search(client, { library: SMALL.uuid });
    expect(small.isError).toBe(false);
    expect(small.body.total).toBe(SMALL.tracks);
    expect(small.body.tracks.every((t) => t.title.startsWith(SMALL.marker))).toBe(true);

    const large = await search(client, { library: LARGE.uuid });
    expect(large.body.total).toBe(LARGE.tracks);
    expect(large.body.tracks.every((t) => t.title.startsWith(LARGE.marker))).toBe(true);

    // A uuid retyped in the other case still names the same library.
    const recased = await search(client, { library: SMALL.uuid.toUpperCase() });
    expect(recased.body.total).toBe(SMALL.tracks);

    await client.close();
  });

  it("selects by absolute m.db path", async () => {
    const { client } = await connectedClient(roots());
    const small = await search(client, { library: smallMdb });
    expect(small.isError).toBe(false);
    expect(small.body.total).toBe(SMALL.tracks);
    expect(small.body.tracks.every((t) => t.title.startsWith(SMALL.marker))).toBe(true);
    await client.close();
  });

  it("returns library_not_found, naming the value and the selectable uuids", async () => {
    const { client } = await connectedClient(roots());
    const r = await client.callTool({
      name: "search_tracks",
      arguments: { limit: 1, library: "not-a-real-library" },
    });
    expect(r.isError).toBe(true);
    const body = r.structuredContent as any;
    expect(body.error).toBe("library_not_found");
    expect(body.message).toContain("not-a-real-library");
    expect(body.detail).toContain(SMALL.uuid);
    expect(body.detail).toContain(LARGE.uuid);
    await client.close();
  });

  it("rejects a path that merely contains a library path", async () => {
    const { client } = await connectedClient(roots());
    const r = await client.callTool({
      name: "search_tracks",
      arguments: { limit: 1, library: smallMdb + "/nope" },
    });
    expect(r.isError).toBe(true);
    expect((r.structuredContent as any).error).toBe("library_not_found");
    await client.close();
  });

  it("honours `library` on every tool that takes it, not only search_tracks", async () => {
    const { client } = await connectedClient(roots());

    // run_sql: counts rows in the library that was asked for.
    for (const [lib, expected] of [
      [SMALL.uuid, SMALL.tracks],
      [LARGE.uuid, LARGE.tracks],
    ] as const) {
      const r = await client.callTool({
        name: "run_sql",
        arguments: { sql: "SELECT COUNT(*) AS c FROM Track", library: lib },
      });
      expect(r.isError).toBeFalsy();
      expect((r.structuredContent as any).rows[0][0]).toBe(expected);
    }

    // get_tracks: id 1 exists in both, so only the title tells them apart.
    const smallTrack = await client.callTool({
      name: "get_tracks",
      arguments: { ids: [1], library: SMALL.uuid },
    });
    expect(String((smallTrack.structuredContent as any).tracks[0].title)).toContain(SMALL.marker);
    const largeTrack = await client.callTool({
      name: "get_tracks",
      arguments: { ids: [1], library: LARGE.uuid },
    });
    expect(String((largeTrack.structuredContent as any).tracks[0].title)).toContain(LARGE.marker);

    // get_track_performance: id 30 exists only in the larger library, so the
    // smaller one must report it as missing rather than answering from the
    // wrong database.
    const beyond = await client.callTool({
      name: "get_track_performance",
      arguments: { id: 30, library: SMALL.uuid },
    });
    expect(beyond.isError).toBe(true);
    const within = await client.callTool({
      name: "get_track_performance",
      arguments: { id: 30, library: LARGE.uuid },
    });
    expect(within.isError).toBeFalsy();

    await client.close();
  });

  it("refresh_index rebuilds the index of the library it was given", async () => {
    const { client } = await connectedClient(roots());

    const refreshed = await client.callTool({
      name: "refresh_index",
      arguments: { library: SMALL.uuid },
    });
    expect(refreshed.isError).toBeFalsy();
    const body = refreshed.structuredContent as any;
    expect(body.rebuilt).toBe(true);
    // The index it built is the small library's: its row count, not the
    // larger library's.
    expect(body.indexed).toBe(SMALL.tracks);

    const listed = await client.callTool({ name: "list_libraries", arguments: {} });
    const libs = (listed.structuredContent as any).libraries;
    expect(libs.find((l: any) => l.uuid === SMALL.uuid).index_generation).toBe(1);
    // The library nobody asked about was never indexed, and listing must not
    // have forked a process to index it either.
    expect(libs.find((l: any) => l.uuid === LARGE.uuid).index_generation).toBeNull();

    await client.close();
  });

  it("audits against the selected library's own folder, not the default library's", async () => {
    const { client } = await connectedClient(roots());

    // Only the small library's files exist on disk (see beforeAll). Handing
    // audit_library the wrong mdb path resolves every relative Track.path
    // against the wrong root, which is silently wrong rather than an error:
    // the small library would report all 12 of its tracks missing.
    const small = await client.callTool({
      name: "audit_library",
      arguments: { checks: ["missing_files"], library: SMALL.uuid },
    });
    expect(small.isError).toBeFalsy();
    expect((small.structuredContent as any).checks[0]).toMatchObject({
      name: "missing_files",
      count: 0,
    });

    const large = await client.callTool({
      name: "audit_library",
      arguments: { checks: ["missing_files"], library: LARGE.uuid },
    });
    expect((large.structuredContent as any).checks[0]).toMatchObject({
      name: "missing_files",
      count: LARGE.tracks,
    });

    await client.close();
  });

  it("forks a query process per library used, lazily, and kills them all on close", async () => {
    // Dedicated fixtures: workerPids matches on the library path, and the
    // shared ones above may still be served by another test's server.
    const ownBase = mkdtempSync(join(tmpdir(), "edj-libsel-procs-"));
    try {
      const aRoot = join(ownBase, "a");
      const bRoot = join(ownBase, "b");
      mkdirSync(aRoot);
      mkdirSync(bRoot);
      const aMdb = makeLibrary(aRoot, { tracks: 4, uuid: SMALL.uuid, marker: SMALL.marker });
      const bMdb = makeLibrary(bRoot, { tracks: 9, uuid: LARGE.uuid, marker: LARGE.marker });

      const { server, client } = await connectedClient([aRoot, bRoot], join(ownBase, "sidecars"));
      expect(workerPids(aMdb)).toEqual([]);
      expect(workerPids(bMdb)).toEqual([]);

      // Touching one library must not fork a child for the other: a DJ with
      // four drives mounted pays for the one library they asked about.
      const first = await client.callTool({
        name: "search_tracks",
        arguments: { limit: 1, library: SMALL.uuid },
      });
      expect(first.isError).toBeFalsy();
      expect(workerPids(aMdb).length).toBe(1);
      expect(workerPids(bMdb)).toEqual([]);

      const second = await client.callTool({
        name: "search_tracks",
        arguments: { limit: 1, library: LARGE.uuid },
      });
      expect(second.isError).toBeFalsy();
      const aPids = workerPids(aMdb);
      const bPids = workerPids(bMdb);
      expect(aPids.length).toBe(1);
      expect(bPids.length).toBe(1);

      // Reused, not re-forked, on a second call to the same library.
      await client.callTool({ name: "search_tracks", arguments: { limit: 1, library: SMALL.uuid } });
      expect(workerPids(aMdb)).toEqual(aPids);

      await client.close();
      await server.close();
      for (let i = 0; i < 50 && workerPids(aMdb).length + workerPids(bMdb).length > 0; i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      // dispose() must tear down every child, not just the first library's.
      expect(workerPids(aMdb)).toEqual([]);
      expect(workerPids(bMdb)).toEqual([]);
    } finally {
      rmSync(ownBase, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("selecting a library by the path list_libraries just reported", () => {
  let homeRoot: string, otherBase: string, otherRoot: string;

  beforeAll(() => {
    // Rooted under $HOME on purpose: a fixture under os.tmpdir() contains no
    // $HOME at all, so a "the ~/... form is accepted" assertion against it
    // would pass whether or not expandHome ran.
    homeRoot = mkdtempSync(join(homedir(), ".edj-mcp-libsel-home-"));
    otherBase = mkdtempSync(join(tmpdir(), "edj-libsel-other-"));
    otherRoot = join(otherBase, "drive");
    mkdirSync(otherRoot);
    makeLibrary(homeRoot, { tracks: 9, uuid: SMALL.uuid, marker: SMALL.marker });
    makeLibrary(otherRoot, LARGE);
  });
  afterAll(() => {
    rmSync(homeRoot, { recursive: true, force: true });
    rmSync(otherBase, { recursive: true, force: true });
  });

  it("accepts the tilde-redacted path a caller echoes straight back", async () => {
    const { client } = await connectedClient(
      [homeRoot, otherRoot],
      join(otherBase, "sidecars-home"),
    );

    const listed = await client.callTool({ name: "list_libraries", arguments: {} });
    const reported = String(
      (listed.structuredContent as any).libraries.find((l: any) => l.uuid === SMALL.uuid).path,
    );
    // The value under test really is the redacted form, not an absolute path.
    expect(reported.startsWith("~/")).toBe(true);
    expect(reported).not.toContain(homedir());

    const picked = await search(client, { library: reported });
    expect(picked.isError).toBe(false);
    expect(picked.body.total).toBe(9);
    expect(picked.body.tracks.every((t) => t.title.startsWith(SMALL.marker))).toBe(true);

    // And it is not what the default would have chosen, so this cannot pass
    // by ignoring `library` entirely.
    const dflt = await search(client, {});
    expect(dflt.body.total).toBe(LARGE.tracks);

    await client.close();
  });
});

describe("selecting a library whose schema is unsupported", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "edj-libsel-old-"));
    mkdirSync(join(root, "old"));
    mkdirSync(join(root, "new"));
    // Deliberately both first in scan order *and* far larger, so "most
    // tracks" alone would pick it and only the supported check rules it out.
    makeLibrary(join(root, "old"), {
      tracks: 90,
      schema: [2, 18, 0],
      uuid: SMALL.uuid,
      marker: SMALL.marker,
    });
    makeLibrary(join(root, "new"), LARGE);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("never defaults to it while a supported library is present", async () => {
    const { client } = await connectedClient(
      [join(root, "old"), join(root, "new")],
      join(root, "sidecars-a"),
    );
    const r = await search(client, {});
    expect(r.isError).toBe(false);
    expect(r.body.total).toBe(LARGE.tracks);
    expect(r.body.tracks.every((t) => t.title.startsWith(LARGE.marker))).toBe(true);
    await client.close();
  });

  it("reports unsupported_schema when it is asked for by name", async () => {
    const { client } = await connectedClient(
      [join(root, "old"), join(root, "new")],
      join(root, "sidecars-b"),
    );
    const r = await client.callTool({
      name: "search_tracks",
      arguments: { limit: 1, library: SMALL.uuid },
    });
    expect(r.isError).toBe(true);
    // Not library_not_found: it was found, it just cannot be read.
    expect((r.structuredContent as any).error).toBe("unsupported_schema");
    await client.close();
  });

  it("still reports unsupported_schema by default when nothing is supported", async () => {
    const onlyOld = mkdtempSync(join(tmpdir(), "edj-libsel-onlyold-"));
    try {
      mkdirSync(join(onlyOld, "one"));
      mkdirSync(join(onlyOld, "two"));
      makeLibrary(join(onlyOld, "one"), { tracks: 5, schema: [2, 18, 0], uuid: SMALL.uuid });
      makeLibrary(join(onlyOld, "two"), { tracks: 8, schema: [1, 6, 0], uuid: LARGE.uuid });
      const { client } = await connectedClient(
        [join(onlyOld, "one"), join(onlyOld, "two")],
        join(onlyOld, "sidecars"),
      );
      const r = await client.callTool({ name: "search_tracks", arguments: { limit: 1 } });
      expect(r.isError).toBe(true);
      expect((r.structuredContent as any).error).toBe("unsupported_schema");
      await client.close();
    } finally {
      rmSync(onlyOld, { recursive: true, force: true });
    }
  });
});

describe("what a model is told about choosing a library", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "edj-libsel-docs-"));
    makeLibrary(root, { tracks: 3 });
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const TAKES_LIBRARY = [
    "search_tracks",
    "get_tracks",
    "get_track_performance",
    "audit_library",
    "run_sql",
    "refresh_index",
  ];

  it("advertises `library` on exactly the tools that accept it", async () => {
    const { client } = await connectedClient([root], join(root, "sidecars-docs"));
    const { tools } = await client.listTools();
    for (const name of TAKES_LIBRARY) {
      const tool = tools.find((t) => t.name === name)!;
      expect(tool, name).toBeDefined();
      expect(Object.keys(tool.inputSchema.properties ?? {}), name).toContain("library");
      // Optional everywhere: a DJ with one library must never have to name it.
      expect((tool.inputSchema.required ?? []) as string[], name).not.toContain("library");
      expect(String(tool.description), name).toContain("library");
      expect(tool.annotations?.readOnlyHint, name).toBe(true);
    }
    // list_libraries takes no arguments; it is what produces the values.
    const list = tools.find((t) => t.name === "list_libraries")!;
    expect(Object.keys(list.inputSchema.properties ?? {})).not.toContain("library");
    expect(String(list.description)).toContain("library");
    await client.close();
  });

  it("documents the selection rules in the engine://schema resource", async () => {
    const { client } = await connectedClient([root], join(root, "sidecars-docs2"));
    const res = await client.readResource({ uri: "engine://schema" });
    const text = String((res.contents[0] as { text: string }).text);
    expect(text).toContain("library_not_found");
    expect(text).toContain("most tracks");
    for (const name of TAKES_LIBRARY) expect(text, name).toContain(name);
    await client.close();
  });
});
