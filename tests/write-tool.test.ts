// tests/write-tool.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { makeLibrary, addPlaylists } from "./fixtures/gen-library.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";

// There is no shared test client helper in this repo: tests/server.test.ts
// and tests/library-selection.test.ts each define their own connectedClient.
// This file follows that pattern rather than introducing a shared one, and
// adds the allowWrites option this feature needs.
const openServers: { dispose(): void }[] = [];
async function connectedClient(
  roots: string[],
  sidecarBaseDir: string,
  extra: { allowWrites?: boolean; backupBaseDir?: string } = {},
) {
  const server = await createServer({ roots, sidecarBaseDir, ...extra });
  openServers.push(server);
  const client = new Client({ name: "test-client", version: "0" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
}
afterEach(() => {
  for (const s of openServers.splice(0)) s.dispose();
});

function lib() {
  const dir = mkdtempSync(join(tmpdir(), "wt-"));
  const dbPath = makeLibrary(dir, { tracks: 8, uuid: "tool-uuid" });
  // PlaylistSpec has no trackIds shorthand -- id, nextListId and each
  // entry's chain link are given explicitly, the same as any other fixture
  // playlist (see gen-library.ts).
  addPlaylists(dbPath, [
    { id: 1, title: "Old", nextListId: 0, entries: [{ id: 1, trackId: 1, next: 0 }] },
  ]);
  return { dir, dbPath };
}

/**
 * Two playlists, so a test can prove `playlist_name` resolves against the
 * one actually named, not a `playlist_id ?? 1` that would be indistinguishable
 * from real resolution against `lib()`'s single-playlist fixture. "Second"
 * carries three entries, enough for a reorder to be meaningful too.
 */
function libTwo() {
  const dir = mkdtempSync(join(tmpdir(), "wt-"));
  const dbPath = makeLibrary(dir, { tracks: 8, uuid: "tool-uuid" });
  addPlaylists(dbPath, [
    { id: 1, title: "Old", nextListId: 2, entries: [{ id: 1, trackId: 1, next: 0 }] },
    {
      id: 2,
      title: "Second",
      nextListId: 0,
      entries: [
        { id: 2, trackId: 2, next: 3 },
        { id: 3, trackId: 3, next: 4 },
        { id: 4, trackId: 4, next: 0 },
      ],
    },
  ]);
  return { dir, dbPath };
}

/** Entry chain of one playlist, head to tail, as track ids. */
function trackOrder(dbPath: string, listId: number): number[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const rows = db
    .prepare("SELECT id, trackId, nextEntityId FROM PlaylistEntity WHERE listId = ?")
    .all(listId) as any[];
  db.close();
  const byId = new Map(rows.map((r) => [r.id, r]));
  const targets = new Set(rows.map((r) => r.nextEntityId));
  let cur = rows.find((r) => !targets.has(r.id));
  const out: number[] = [];
  const seen = new Set<number>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.push(cur.trackId);
    cur = byId.get(cur.nextEntityId);
  }
  return out;
}

describe("create_playlist tool", () => {
  it("is absent unless the server was started with writes enabled", async () => {
    const { dir } = lib();
    const { client } = await connectedClient([dir], join(dir, "sc"));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).not.toContain("create_playlist");
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("appears and writes when writes are enabled", async () => {
    const { dir, dbPath } = lib();
    const backupBaseDir = join(dir, "backups");
    const { client } = await connectedClient([dir], join(dir, "sc"), { allowWrites: true, backupBaseDir });
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "create_playlist")!;
    expect(tool).toBeDefined();
    expect(tool.annotations?.readOnlyHint).toBe(false);

    const res: any = await client.callTool({
      name: "create_playlist",
      arguments: { title: "From MCP", track_ids: [3, 1] },
    });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent.tracks_added).toBe(2);
    // The user's way back from a write; prove it survives the MCP layer,
    // not just the store function it comes from.
    expect(typeof res.structuredContent.backup_path).toBe("string");
    expect(res.structuredContent.backup_path.length).toBeGreaterThan(0);

    // The snapshot must land where the caller asked, not in the real
    // ~/.engine-dj-mcp/backups: before backupBaseDir existed, every run of
    // this suite deposited a full copy of a throwaway fixture in the user's
    // home directory, under a fresh temp-path tag that rotation could never
    // reclaim. They accumulated forever.
    expect(res.structuredContent.backup_path.startsWith(backupBaseDir)).toBe(true);
    expect(readdirSync(backupBaseDir).filter((f) => f.endsWith(".db")).length).toBe(1);

    const db = new DatabaseSync(dbPath, { readOnly: true });
    expect((db.prepare("SELECT COUNT(*) c FROM Playlist WHERE title='From MCP'").get() as any).c).toBe(1);
    db.close();
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns playlist_exists as a tool error, not a crash", async () => {
    const { dir } = lib();
    const { client } = await connectedClient([dir], join(dir, "sc"), { allowWrites: true });
    const res: any = await client.callTool({
      name: "create_playlist",
      arguments: { title: "Old", track_ids: [2] },
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent.error).toBe("playlist_exists");
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("playlist edit tools", () => {
  it("registers all three edit tools only with writes enabled", async () => {
    const { dir } = lib();
    const off = await connectedClient([dir], join(dir, "sc1"));
    const offNames = (await off.client.listTools()).tools.map((t) => t.name);
    for (const n of ["add_tracks_to_playlist", "remove_tracks_from_playlist", "reorder_playlist"]) {
      expect(offNames, n).not.toContain(n);
    }
    await off.client.close();

    const on = await connectedClient([dir], join(dir, "sc2"), { allowWrites: true, backupBaseDir: join(dir, "b") });
    const onTools = (await on.client.listTools()).tools;
    for (const n of ["add_tracks_to_playlist", "remove_tracks_from_playlist", "reorder_playlist"]) {
      const t = onTools.find((x) => x.name === n)!;
      expect(t, n).toBeDefined();
      expect(t.annotations?.readOnlyHint, n).toBe(false);
    }
    await on.client.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("advertises which writes are destructive, because clients confirm on that flag", async () => {
    // destructiveHint: false has a defined meaning in MCP -- "additive
    // updates only" -- and a client reads it to decide whether to ask the
    // user first. Adding tracks is additive; deleting entries from a list
    // someone plays live, or rewriting its order, is not.
    const { dir } = lib();
    const { client } = await connectedClient([dir], join(dir, "sc"), {
      allowWrites: true,
      backupBaseDir: join(dir, "b"),
    });
    const tools = (await client.listTools()).tools;
    const hint = (n: string) => tools.find((t) => t.name === n)!.annotations?.destructiveHint;
    expect(hint("create_playlist")).toBe(false);
    expect(hint("add_tracks_to_playlist")).toBe(false);
    expect(hint("remove_tracks_from_playlist")).toBe(true);
    expect(hint("reorder_playlist")).toBe(true);
    expect(hint("update_track_metadata")).toBe(true);
    // Spec §7.4: a repeat of the same call changes nothing (§5.2).
    expect(tools.find((t) => t.name === "update_track_metadata")!.annotations?.idempotentHint).toBe(true);
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports a playlist that is not there as playlist_not_found, the code it documents", async () => {
    // Resolution runs before the store function, so the store's own
    // playlist_not_found was unreachable through MCP: every miss came back
    // as invalid_argument, a code the README does not list for these tools.
    // Ambiguity still is an argument problem and still reports as such.
    const { dir } = lib();
    const { client } = await connectedClient([dir], join(dir, "sc"), {
      allowWrites: true,
      backupBaseDir: join(dir, "b"),
    });
    for (const [name, args] of [
      ["add_tracks_to_playlist", { playlist_id: 999, track_ids: [2] }],
      ["remove_tracks_from_playlist", { playlist_id: 999, positions: [1] }],
      ["reorder_playlist", { playlist_id: 999, order: [1] }],
      ["add_tracks_to_playlist", { playlist_name: "Nope", track_ids: [2] }],
    ] as const) {
      const res: any = await client.callTool({ name, arguments: args as any });
      expect(res.isError, name).toBe(true);
      expect(res.structuredContent.error, `${name} ${JSON.stringify(args)}`).toBe("playlist_not_found");
      // Every other playlist_not_found (raised inside store/write.ts once an
      // id reaches it) carries detail: "not_committed" -- a client reads
      // that field to decide whether the library changed (errors.ts), and
      // nothing was ever attempted here either. It has to match, even though
      // that leaves no room in `detail` for the candidate listing this code
      // used to carry there; a human still has to be able to find it, so it
      // is asserted in `message` instead.
      expect(res.structuredContent.detail, `${name} ${JSON.stringify(args)}`).toBe("not_committed");
      expect(res.structuredContent.message, `${name} ${JSON.stringify(args)}`).toContain("1 -- Old");
    }
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("edits a playlist named by name, and hands back a usable undo", async () => {
    const { dir, dbPath } = lib();
    const { client } = await connectedClient([dir], join(dir, "sc"), {
      allowWrites: true,
      backupBaseDir: join(dir, "b"),
    });
    const res: any = await client.callTool({
      name: "add_tracks_to_playlist",
      arguments: { playlist_name: "Old", track_ids: [4] },
    });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent.undo[0].tool).toBe("remove_tracks_from_playlist");

    const undo = res.structuredContent.undo[0];
    const back: any = await client.callTool({ name: undo.tool, arguments: undo.arguments });
    expect(back.isError).toBeFalsy();

    const db = new DatabaseSync(dbPath, { readOnly: true });
    expect((db.prepare("SELECT COUNT(*) c FROM PlaylistEntity WHERE listId = 1").get() as any).c).toBe(1);
    db.close();
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // Task 6's review left this uncovered: reorder_playlist was checked only
  // for presence in tools/list, never actually called through the MCP
  // layer. A runReorderPlaylist that always threw, or silently did nothing,
  // would have passed everything else in this file.
  it("reorders a playlist end to end, and its undo restores the original order", async () => {
    const { dir, dbPath } = libTwo();
    const { client } = await connectedClient([dir], join(dir, "sc"), {
      allowWrites: true,
      backupBaseDir: join(dir, "b"),
    });

    expect(trackOrder(dbPath, 2)).toEqual([2, 3, 4]);

    const res: any = await client.callTool({
      name: "reorder_playlist",
      arguments: { playlist_id: 2, order: [3, 1, 2] },
    });
    expect(res.isError).toBeFalsy();
    expect(trackOrder(dbPath, 2)).toEqual([4, 2, 3]);

    const undo = res.structuredContent.undo[0];
    expect(undo.tool).toBe("reorder_playlist");
    const back: any = await client.callTool({ name: undo.tool, arguments: undo.arguments });
    expect(back.isError).toBeFalsy();
    expect(trackOrder(dbPath, 2)).toEqual([2, 3, 4]);

    await client.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // The other tests in this file resolve playlist_name against libraries
  // holding exactly one playlist, so a resolveListId that ignored
  // playlist_name entirely and used `playlist_id ?? 1` would be
  // indistinguishable from real name resolution. This fixture holds two.
  it("resolves playlist_name against the playlist actually named, not playlist_id ?? 1", async () => {
    const { dir, dbPath } = libTwo();
    const { client } = await connectedClient([dir], join(dir, "sc"), {
      allowWrites: true,
      backupBaseDir: join(dir, "b"),
    });

    const res: any = await client.callTool({
      name: "add_tracks_to_playlist",
      arguments: { playlist_name: "Second", track_ids: [5], at: "end" },
    });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent.playlist_id).toBe(2);
    expect(trackOrder(dbPath, 2)).toEqual([2, 3, 4, 5]);
    // "Old" (id 1), not named by this call, must be untouched.
    expect(trackOrder(dbPath, 1)).toEqual([1]);

    await client.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("update_track_metadata over MCP", () => {
  const call = async (client: any, args: Record<string, unknown>) =>
    client.callTool({ name: "update_track_metadata", arguments: args });

  it("is not offered without --allow-writes", async () => {
    const { dir } = lib();
    const { client } = await connectedClient([dir], join(dir, "sc"));
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("update_track_metadata");
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("edits, and its undo replays verbatim into the same library", async () => {
    const { dir, dbPath } = lib();
    const { client } = await connectedClient([dir], join(dir, "sc"), { allowWrites: true, backupBaseDir: join(dir, "b") });
    const genre = () => {
      const db = new DatabaseSync(`file:${dbPath}?mode=ro`, { readOnly: true });
      const g = (db.prepare("SELECT genre FROM Track WHERE id = 1").get() as any).genre;
      db.close();
      return g;
    };
    const before = genre();
    const r = (await call(client, { updates: [{ id: 1, genre: "Zzz Test Genre" }] })).structuredContent as any;
    expect(r.error).toBeUndefined();
    expect(genre()).toBe("Zzz Test Genre");
    const step = r.undo[0];
    expect(step.arguments.library).toBe(dbPath);
    const back = (await client.callTool({ name: step.tool, arguments: step.arguments })).structuredContent as any;
    expect(back.error).toBeUndefined();
    expect(genre()).toBe(before);
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("leaves schema violations to zod, which answers without a structured error", async () => {
    // Spec §7.1: types and the 200 cap live in the schema, as for every write tool.
    const { dir } = lib();
    const { client } = await connectedClient([dir], join(dir, "sc"), { allowWrites: true, backupBaseDir: join(dir, "b") });
    const tooMany = Array.from({ length: 201 }, (_, i) => ({ id: i + 1, genre: "x" }));
    for (const args of [
      { updates: tooMany },
      { updates: [{ id: 1, rating: 4 }] },
      // `Expect` must be .strict(): without it, zod silently strips an
      // unrecognised key such as `rating` (the store field is `rating_raw`)
      // instead of rejecting the call.
      { updates: [{ id: 1, genre: "x", expect: { rating: 0 } }] },
    ]) {
      const r = await call(client, args);
      expect(r.isError).toBe(true);
      expect(r.structuredContent).toBeUndefined();
    }
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns store refusals as structured errors with not_committed", async () => {
    const { dir } = lib();
    const { client } = await connectedClient([dir], join(dir, "sc"), { allowWrites: true, backupBaseDir: join(dir, "b") });
    const r = (await call(client, { updates: [{ id: 1, rating_raw: 4 }] })).structuredContent as any;
    expect(r.error).toBe("invalid_argument");
    expect(r.detail).toBe("not_committed");
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not build the search index, which it does not use", async () => {
    // Spec §6.2: addressing by id needs no index, and building one before a
    // write makes it stale the moment the write commits.
    const { dir } = lib();
    const sc = join(dir, "sc");
    const { client } = await connectedClient([dir], sc, { allowWrites: true, backupBaseDir: join(dir, "b") });
    const r = (await call(client, { updates: [{ id: 1, genre: "Zzz" }] })).structuredContent as any;
    expect(r.error).toBeUndefined();
    expect(existsSync(join(sc, "tool-uuid"))).toBe(false);
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses ambiguously with two supported libraries connected, and writes to neither", async () => {
    // Guards against the write handler resolving the library with
    // selectLibrary (which defaults an omitted `library` to the biggest
    // library) instead of selectForWrite (which refuses). Two different
    // track counts, so a wrong-disk pick would be a defect this test catches.
    const rootA = mkdtempSync(join(tmpdir(), "wt-amb-a-"));
    const rootB = mkdtempSync(join(tmpdir(), "wt-amb-b-"));
    const dbA = makeLibrary(rootA, { tracks: 8, uuid: "amb-uuid-a" });
    const dbB = makeLibrary(rootB, { tracks: 9, uuid: "amb-uuid-b" });
    const backupBaseDir = join(rootA, "backups");
    const { client } = await connectedClient([rootA, rootB], join(rootA, "sc"), {
      allowWrites: true,
      backupBaseDir,
    });

    const genreOf = (p: string) => {
      const db = new DatabaseSync(p, { readOnly: true });
      const g = (db.prepare("SELECT genre FROM Track WHERE id = 1").get() as any).genre;
      db.close();
      return g;
    };
    const beforeA = genreOf(dbA);
    const beforeB = genreOf(dbB);

    const r = (await call(client, { updates: [{ id: 1, genre: "Ambiguous" }] })).structuredContent as any;
    expect(r.error).toBe("ambiguous_library");
    expect(r.detail).toBe("not_committed");
    expect(genreOf(dbA)).toBe(beforeA);
    expect(genreOf(dbB)).toBe(beforeB);
    expect(existsSync(backupBaseDir)).toBe(false);

    await client.close();
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  });

  it("refuses an unsupported library it would otherwise have written", async () => {
    // Without ensureFresh nothing else checks the schema on this path.
    const dir = mkdtempSync(join(tmpdir(), "wt-"));
    makeLibrary(dir, { tracks: 4, schema: [2, 18, 0] });
    const { client } = await connectedClient([dir], join(dir, "sc"), { allowWrites: true, backupBaseDir: join(dir, "b") });
    const r = (await call(client, { updates: [{ id: 1, genre: "x" }] })).structuredContent as any;
    expect(r.error).toBe("unsupported_schema");
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
