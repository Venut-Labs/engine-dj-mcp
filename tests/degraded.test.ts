// tests/degraded.test.ts
//
// Drives real MCP *tools*, through a real client, against a *degraded*
// library: one that Engine DJ is holding a write lock on. Every other suite
// in this repo exercises degradation one layer down (openQueryConnection,
// IndexManager, QueryProcess) against a healthy-enough library, which is how
// the headline failure survived so long: each layer behaved correctly on its
// own, and the defect lived in how the server's ready() gate combined them.
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { makeLibrary } from "./fixtures/gen-library.js";
import { createServer } from "../src/server.js";

async function connect(roots: string[], sidecarBaseDir: string) {
  const server = await createServer({ roots, sidecarBaseDir });
  const client = new Client({ name: "degraded-test-client", version: "0" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
}

/**
 * Holds a genuine SQLite EXCLUSIVE lock, the way Engine DJ does while it
 * writes. This is not a synthetic marker file: any reader (including the
 * sidecar build) gets SQLITE_BUSY until it is released.
 */
function holdExclusive(mdb: string): DatabaseSync {
  const holder = new DatabaseSync(mdb);
  holder.exec("BEGIN EXCLUSIVE");
  holder.exec("UPDATE Track SET rating = 3 WHERE id = 1");
  return holder;
}

describe("tools against a library that has never been indexed and is locked right now", () => {
  it(
    "reports index_stale with retry_after_ms from every gated tool, never a raw SQLite string",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "edj-degraded-"));
      const mdb = makeLibrary(dir, { tracks: 100 });
      // The server is created before the lock is taken, because discovery
      // itself reads the Information table; the scenario under test is a
      // *first query* arriving while Engine DJ writes, with no sidecar ever
      // built. sidecarBaseDir is fresh, so nothing is on disk to fall back to.
      const { server, client } = await connect([dir], join(dir, "sidecars"));
      const holder = holdExclusive(mdb);
      try {
        for (const [name, args] of [
          ["search_tracks", { limit: 5 }],
          ["get_tracks", { ids: [1] }],
          ["audit_library", { checks: ["unanalyzed"] }],
          ["run_sql", { sql: "SELECT COUNT(*) AS c FROM Track" }],
        ] as const) {
          const r = await client.callTool({ name, arguments: args as Record<string, unknown> });
          const body = r.structuredContent as Record<string, unknown>;
          expect(r.isError, `${name} must fail structurally`).toBe(true);
          expect(body.error, `${name} must report index_stale`).toBe("index_stale");
          expect(body.retry_after_ms, `${name} must tell the model when to retry`).toBe(5000);
          // The actual regression: the caller used to receive
          // invalid_argument carrying "no such table: side.track_derived".
          expect(JSON.stringify(body)).not.toMatch(/no such table/i);
          expect(JSON.stringify(body)).not.toMatch(/invalid_argument/);
        }
      } finally {
        holder.exec("ROLLBACK");
        holder.close();
        await client.close();
        await server.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    60_000,
  );

  it(
    "answers normally again once the writer releases the lock",
    async () => {
      // Without this, the test above would also pass against a server that
      // simply refused every request forever.
      const dir = mkdtempSync(join(tmpdir(), "edj-degraded-recover-"));
      const mdb = makeLibrary(dir, { tracks: 40 });
      const { server, client } = await connect([dir], join(dir, "sidecars"));
      const holder = holdExclusive(mdb);
      try {
        const blocked = await client.callTool({ name: "search_tracks", arguments: { limit: 5 } });
        expect((blocked.structuredContent as any).error).toBe("index_stale");

        holder.exec("ROLLBACK");
        holder.close();

        const ok = await client.callTool({ name: "search_tracks", arguments: { limit: 5 } });
        expect(ok.isError).toBeFalsy();
        expect((ok.structuredContent as any).tracks.length).toBe(5);
      } finally {
        await client.close();
        await server.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    60_000,
  );
});

describe("a second server started against an index a previous run already built", () => {
  it(
    "attaches that index instead of querying a database with no `side` schema",
    async () => {
      // ensureFresh's "nothing changed" path never rebuilds, so it never
      // used to attach either -- a QueryProcess starts with no sidecar, so
      // the very first query of the second run hit
      // "no such table: side.track_derived" on a perfectly healthy library.
      const dir = mkdtempSync(join(tmpdir(), "edj-restart-"));
      makeLibrary(dir, { tracks: 30 });
      const sidecars = join(dir, "sidecars");
      try {
        const first = await connect([dir], sidecars);
        const built = await first.client.callTool({ name: "search_tracks", arguments: { limit: 3 } });
        expect(built.isError).toBeFalsy();
        await first.client.close();
        await first.server.close();

        const second = await connect([dir], sidecars);
        const r = await second.client.callTool({ name: "search_tracks", arguments: { limit: 3 } });
        expect(JSON.stringify(r.structuredContent)).not.toMatch(/no such table/i);
        expect(r.isError).toBeFalsy();
        expect((r.structuredContent as any).tracks.length).toBe(3);
        await second.client.close();
        await second.server.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
