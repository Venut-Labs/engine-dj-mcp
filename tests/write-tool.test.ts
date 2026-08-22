// tests/write-tool.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
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
  extra: { allowWrites?: boolean } = {},
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
    const { client } = await connectedClient([dir], join(dir, "sc"), { allowWrites: true });
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
