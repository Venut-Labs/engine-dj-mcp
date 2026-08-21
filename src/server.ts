// src/server.ts
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { discoverLibraries } from "./discovery.js";
import { libraryCandidates } from "./paths.js";
import { hasHotJournal } from "./store/connections.js";
import { QueryProcess } from "./proc/query-client.js";
import { IndexManager } from "./store/index-manager.js";
import { searchTracks, SearchInput } from "./tools/search.js";
import { getTracks, GetTracksInput } from "./tools/tracks.js";
import { getTrackPerformance, PerformanceInput } from "./tools/performance.js";
import { auditLibrary, AuditInput, AUDIT_CHECKS } from "./tools/audit.js";
import { runSql, RunSqlInput } from "./tools/sql.js";
import { listLibraries } from "./tools/libraries.js";
import { refreshIndex } from "./tools/refresh.js";
import { err, isEngineError } from "./errors.js";

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true } as const;

function reply(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
    isError: isEngineError(value),
  };
}

/**
 * discovery.ts's own default-root walk (home `Music` folder, then every
 * `/Volumes` mount) is a private implementation detail and its exported
 * interface is locked for this task, so it cannot be reused directly.
 * Duplicated here -- deliberately tiny -- only so a hot journal can still be
 * located when discoverLibraries() has already silently dropped the one
 * candidate that carries it (see findHotJournalCandidate below).
 */
function defaultRoots(): string[] {
  const roots = [join(homedir(), "Music")];
  try {
    for (const vol of readdirSync("/Volumes")) roots.push(join("/Volumes", vol));
  } catch {
    // /Volumes does not exist off macOS; ignore.
  }
  return roots;
}

/**
 * discoverLibraries() reports only libraries it could actually read, by
 * design (a permissions error on one candidate must not blank out every
 * other one). That means a hot journal on the *only* library on this
 * machine looks identical to no library existing at all -- both come back
 * as an empty list, verified: opening it raises "attempt to write a
 * readonly database", which readLibraryInfo currently folds into
 * unsupported_schema and then drops entirely.
 *
 * This walks the same candidate paths independently, purely to tell those
 * two cases apart, so `ready()` below can report library_needs_recovery
 * instead of the misleading library_not_found -- never to open the file:
 * recovering a hot journal requires a write, and this project never writes
 * to the user's library, even to heal it.
 */
export function findHotJournalCandidate(roots: string[]): string | null {
  for (const root of roots) {
    for (const candidate of libraryCandidates(root)) {
      if (existsSync(candidate) && hasHotJournal(candidate)) return candidate;
    }
  }
  return null;
}

export async function createServer(
  opts: { roots?: string[]; sidecarBaseDir?: string } = {},
): Promise<McpServer> {
  const server = new McpServer({ name: "engine-dj-mcp", version: "0.1.0" });

  const libs = discoverLibraries(opts.roots);
  // Prefer a library whose schema this project actually understands; fall
  // back to the first one found (even unsupported) only so ensureFresh's own
  // unsupported_schema error -- specific and actionable -- reaches the
  // caller instead of the same generic library_not_found a hot journal would
  // otherwise be flattened into.
  const primary = libs.find((l) => l.supported) ?? libs[0] ?? null;
  const qp = primary ? new QueryProcess(primary.path, null, 10_000) : null;
  const mgr = primary && qp ? new IndexManager(primary, qp, opts.sidecarBaseDir) : null;

  // Shared by every tool for the "no primary library" case, so refresh_index
  // cannot end up as the one call site that still flattens a hot journal
  // into library_not_found while the rest correctly report
  // library_needs_recovery.
  const noLibraryError = () => {
    const hotPath = findHotJournalCandidate(opts.roots ?? defaultRoots());
    return hotPath
      ? err(
          "library_needs_recovery",
          "The Engine library was closed uncleanly and has an unrecovered journal. " +
            "Launch Engine DJ once so it can recover the library, then retry.",
        )
      : err("library_not_found", "No supported Engine DJ library was found");
  };

  const ready = async () => {
    if (!qp || !mgr) return noLibraryError();
    const fresh = await mgr.ensureFresh();
    return isEngineError(fresh) && fresh.error !== "index_stale" ? fresh : null;
  };

  /**
   * Shared by the engine://libraries resource and the list_libraries tool so
   * neither can drift from the other. index_generation only appears once a
   * sidecar has actually been built at least once in this process -- a
   * never-built IndexManager still reports generation 0, which is not a real
   * generation number and must read as null, not as "generation zero".
   */
  const libraryReport = async () => {
    if (mgr) await mgr.ensureFresh(); // best effort: keeps the generation accurate even as the first call of a session
    const generations = new Map<string, number>();
    if (mgr && primary && mgr.generation > 0) generations.set(primary.uuid, mgr.generation);
    return listLibraries(generations, libs);
  };

  server.registerResource(
    "schema",
    "engine://schema",
    { title: "Engine DJ schema and semantics", mimeType: "text/markdown" },
    async (uri) => ({ contents: [{ uri: uri.href, text: SCHEMA_NOTE }] }),
  );

  server.registerResource(
    "libraries",
    "engine://libraries",
    { title: "Discovered Engine DJ libraries", mimeType: "application/json" },
    async (uri) => ({ contents: [{ uri: uri.href, text: JSON.stringify(await libraryReport(), null, 2) }] }),
  );

  server.registerTool(
    "search_tracks",
    {
      title: "Search tracks",
      description:
        "Search the Engine DJ library by text, tempo, key, rating, play history and analysis " +
        "flags. Set include_total for a count alongside the page: it is capped at 1000, and a " +
        "capped result comes back as total: 1000 with total_capped: true -- treat that as " +
        "'at least 1000', never as an exact count.",
      inputSchema: SearchInput.shape,
      annotations: RO,
    },
    async (args) => {
      const gate = await ready();
      if (gate) return reply(gate);
      return reply(await searchTracks(qp!, args as any));
    },
  );

  server.registerTool(
    "get_tracks",
    {
      title: "Get tracks by id",
      description: "Fetch full metadata for specific track ids, in the order requested.",
      inputSchema: GetTracksInput.shape,
      annotations: RO,
    },
    async (args) => {
      const gate = await ready();
      if (gate) return reply(gate);
      return reply(await getTracks(qp!, args as any));
    },
  );

  server.registerTool(
    "get_track_performance",
    {
      title: "Get cues, loops and beatgrid",
      description: "Decode PerformanceData for one track. Each field carries its own decode status.",
      inputSchema: PerformanceInput.shape,
      annotations: RO,
    },
    async (args) => {
      const gate = await ready();
      if (gate) return reply(gate);
      return reply(await getTrackPerformance(qp!, args as any));
    },
  );

  server.registerTool(
    "audit_library",
    {
      title: "Audit the collection",
      description: `Run collection health checks. Available: ${AUDIT_CHECKS.join(", ")}.`,
      inputSchema: AuditInput.shape,
      annotations: RO,
    },
    async (args) => {
      const gate = await ready();
      if (gate) return reply(gate);
      return reply(await auditLibrary(qp!, primary!.path, args as any));
    },
  );

  server.registerTool(
    "run_sql",
    {
      title: "Run a read-only SQL query",
      description:
        "Escape hatch for questions the other tools do not cover. Read-only is enforced by the " +
        "kernel, not by this check alone. Use side.track_derived.camelot and side.track_derived.tempo " +
        "in WHERE clauses rather than the camelot()/tempo() SQL functions, which run per row and defeat " +
        "indexes.",
      inputSchema: RunSqlInput.shape,
      annotations: RO,
    },
    async (args) => {
      const gate = await ready();
      if (gate) return reply(gate);
      return reply(await runSql(qp!, args as any));
    },
  );

  server.registerTool(
    "list_libraries",
    {
      title: "List Engine DJ libraries",
      description: "List every discovered library, including ones whose schema is unsupported.",
      inputSchema: {},
      annotations: RO,
    },
    async () => reply(await libraryReport()),
  );

  server.registerTool(
    "refresh_index",
    {
      title: "Refresh the search index",
      description: "Rebuild the search index if the library has changed.",
      inputSchema: {},
      annotations: RO,
    },
    async () => {
      if (!mgr) return reply(noLibraryError());
      return reply(await refreshIndex(mgr));
    },
  );

  return server;
}

const SCHEMA_NOTE = `# Engine DJ library — schema and semantics

Tables live in \`m.db\` (attached as \`main\`); the search index lives in \`side\`.

## Field semantics
- \`Track.key\` is 0..23, \`-1\` means undetermined. The mapping to Camelot
  notation is confirmed against Engine DJ's own display (key=20 shows as 6B,
  exactly what the formula produces). Use \`side.track_derived.camelot\` for
  filtering -- it is indexed. The SQL function \`camelot(key)\` exists but
  runs per row and defeats indexes.
- Real tempo is \`COALESCE(bpmAnalyzed, bpm)\`. \`bpm\` is stored at face
  value -- 102 means 102 BPM, not 10200. It is NOT scaled by 100; that is a
  rekordbox convention, not an Engine one (confirmed against a real Engine
  library: stored values of 102, 105, 128, 145, 147 each matched
  \`bpmAnalyzed\` to within 0.68, and Engine's own interface displays 102 for
  the track stored as 102). \`side.track_derived.tempo\` holds the resolved
  value and is indexed.
- \`Track.path\` is relative to the \`Engine Library\` folder and usually
  contains \`..\`.
- Playlists are singly linked lists: order lives in \`Playlist.nextListId\`
  and \`PlaylistEntity.nextEntityId\`, not in any position column.
- A track's natural key across drives is \`(originDatabaseUuid, originTrackId)\`.

## Sidecar tables
- \`side.fts_track\` — FTS5 over title, artist, album, genre, comment, label,
  with diacritics folded. Join via \`side.fts_map(rowid, track_id)\`.
- \`side.track_derived(track_id, camelot, tempo, has_cues, has_grid)\` — indexed.

## Limits
The connection is read-only at the kernel level, not by convention: writes
are refused by SQLite itself. \`VACUUM\`, \`ATTACH\` and \`DETACH\` are
rejected. Only one statement per call. Queries are killed after 10 seconds.
\`search_tracks\`'s \`total\` (when requested) is capped at 1000; check
\`total_capped\` before treating it as exact.`;
