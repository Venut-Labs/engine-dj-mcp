#!/usr/bin/env node
// src/index.ts
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  // MCP clients configure a server as a command plus an args array, so a flag
  // is visible in that configuration and greppable; an environment variable
  // would not be. Writes are off unless this is present.
  const allowWrites = process.argv.includes("--allow-writes");
  // stderr is not the protocol channel, so this is safe for stdio transport,
  // and it puts the mode in the client's log where a user can check it.
  console.error(`engine-dj-mcp: writes ${allowWrites ? "ENABLED (--allow-writes)" : "disabled"}`);
  const server = await createServer({ allowWrites });
  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  console.error("engine-dj-mcp failed to start:", e);
  process.exit(1);
});
