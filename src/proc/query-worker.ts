// src/proc/query-worker.ts
//
// Forked by QueryProcess (query-client.ts), one process per library. Runs as
// plain compiled JS — see query-client.ts for why the TypeScript source is
// never forked directly.
import { openQueryConnection, reattachSidecar } from "../store/connections.js";
import type { DatabaseSync } from "node:sqlite";

interface Request {
  id: number;
  kind: "query" | "sidecar";
  sql?: string;
  params?: unknown[];
  path?: string;
}

/**
 * IPC serialises with JSON, and node:sqlite returns BLOBs as Uint8Array,
 * which JSON degrades to {"0":1,"1":2,...}. Every blob must be framed
 * explicitly or PerformanceData decoding on the other side receives garbage.
 */
function encodeValue(v: unknown): unknown {
  return v instanceof Uint8Array ? { __blob: Buffer.from(v).toString("base64") } : v;
}

const [, , mdbPath, sidecarArg] = process.argv;
let sidecar: string | null = sidecarArg && sidecarArg !== "-" ? sidecarArg : null;
let db!: DatabaseSync;
let opened = false;

try {
  db = openQueryConnection(mdbPath!, sidecar);
  opened = true;
} catch (e) {
  // openQueryConnection throws (e.g. a hot journal); report it back instead
  // of crashing with a bare stack trace, so the parent can map it to a
  // structured error rather than guessing from an exit code. process.send()
  // is asynchronous, so exit only from its callback -- calling process.exit()
  // right after send() can drop the message before it reaches the pipe.
  const message = (e as Error).message;
  if (process.send) {
    process.send({ ready: false, message }, () => process.exit(1));
  } else {
    process.exit(1);
  }
}

// Only wire up the request loop once the connection actually opened; the
// failure branch above owns reporting and exiting on its own.
if (opened) {
  process.on("message", (req: Request) => {
    try {
      if (req.kind === "sidecar") {
        sidecar = req.path!;
        reattachSidecar(db, sidecar);
        process.send!({ id: req.id, ok: true });
        return;
      }
      const stmt = db.prepare(req.sql!);
      stmt.setReadBigInts(false);
      const rows = stmt.all(...((req.params ?? []) as any[])) as Record<string, unknown>[];
      const columns = rows.length ? Object.keys(rows[0]!) : [];
      process.send!({
        id: req.id,
        ok: true,
        columns,
        rows: rows.map((r) => columns.map((c) => encodeValue(r[c]))),
      });
    } catch (e) {
      process.send!({ id: req.id, ok: false, message: (e as Error).message });
    }
  });

  process.send!({ ready: true });
}
