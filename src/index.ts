#!/usr/bin/env node
// src/index.ts
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const server = await createServer();
  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  // stderr is not the protocol channel, so this is safe for stdio transport.
  console.error("engine-dj-mcp failed to start:", e);
  process.exit(1);
});
