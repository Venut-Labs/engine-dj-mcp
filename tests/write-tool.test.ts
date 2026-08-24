// tests/write-tool.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
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
});
