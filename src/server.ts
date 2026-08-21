// src/server.ts
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { discoverLibraries, defaultRoots, probeLibraries, type LibraryInfo } from "./discovery.js";
import { libraryCandidates, sidecarDir } from "./paths.js";
import {
  LibraryArg,
  findLibrary,
  libraryNotFound,
  pickDefaultLibrary,
} from "./library-select.js";
import { hasHotJournal } from "./store/connections.js";
import { QueryProcess } from "./proc/query-client.js";
import { IndexManager } from "./store/index-manager.js";
import { searchTracks, SearchInput } from "./tools/search.js";
import { getTracks, GetTracksInput } from "./tools/tracks.js";
import { getTrackPerformance, PerformanceInput } from "./tools/performance.js";
import { auditLibrary, AuditInput, AUDIT_CHECKS } from "./tools/audit.js";
import { runSql, RunSqlInput } from "./tools/sql.js";
import { listLibraries, type LibraryEntry } from "./tools/libraries.js";
import { refreshIndex } from "./tools/refresh.js";
import { err, isEngineError, libraryNeedsRecovery, type EngineError } from "./errors.js";

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true } as const;

/**
 * name/version reported to every client on initialize. Read from
 * package.json rather than typed here, so the two cannot re-diverge the way
 * they already have once (this constructor shipped 0.1.0 while package.json
 * said 0.9.0).
 *
 * Resolved via import.meta.url, one directory up from this module, not by
 * relative path from cwd: this runs under `npx` from an arbitrary working
 * directory, and package.json sits next to dist/ (this module's compiled
 * location) in both the repo (src/../package.json) and the installed
 * layout (dist/../package.json) -- package.json is always included in the
 * published tarball regardless of the "files" field, so this path exists
 * in both places even though "files" lists only "dist".
 */
const PACKAGE_INFO = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  name: string;
  version: string;
};

/**
 * Appended to every tool description that takes a `library`. The argument's
 * own schema description (see library-select.ts) is the authoritative text;
 * this repeats the essentials in the description because some clients show a
 * model the description and not the per-property schema documentation.
 */
const LIBRARY_SELECTION_NOTE =
  "With more than one library connected, pass `library` (a uuid or path from list_libraries, " +
  "either the ~/... form or the absolute one) to choose which one; the default is the " +
  "supported library with the most tracks.";

function reply(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
    isError: isEngineError(value),
  };
}

/**
 * discoverLibraries() reports only libraries it could actually read, by
 * design (a permissions error on one candidate must not blank out every
 * other one). That means a hot journal on the *only* library on this
 * machine looks identical to no library existing at all -- both come back
 * as an empty list, verified: readLibraryInfo (discovery.ts) does report a
 * hot journal precisely, as library_needs_recovery, but discoverLibraries()
 * still drops it along with every other unreadable candidate, by that same
 * design.
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

/**
 * An McpServer that also owns one forked query process per library it has
 * been asked to touch, and can therefore be shut down rather than merely
 * disconnected. Nothing else in this server holds an OS resource, so
 * `dispose()` is the whole of it.
 */
export type EngineDjMcpServer = McpServer & {
  /** Kills every query child this server started. Idempotent, and also run by close(). */
  dispose(): void;
};

/**
 * Everything that is per-library: the child process holding that library's
 * read-only connection, and the index manager owning that library's
 * sidecar. Created on first *use* of a library, never at startup -- a DJ
 * with four drives mounted must not pay four forked processes for the one
 * library they are actually asking about.
 */
interface LibraryState {
  lib: LibraryInfo;
  qp: QueryProcess;
  mgr: IndexManager;
}

export async function createServer(
  opts: { roots?: string[]; sidecarBaseDir?: string } = {},
): Promise<EngineDjMcpServer> {
  const server = new McpServer({ name: PACKAGE_INFO.name, version: PACKAGE_INFO.version }) as EngineDjMcpServer;

  const libs = discoverLibraries(opts.roots);

  // Shared by every tool for the "no primary library" case, so refresh_index
  // cannot end up as the one call site that still flattens a hot journal
  // into library_not_found while the rest correctly report
  // library_needs_recovery.
  const noLibraryError = () => {
    const hotPath = findHotJournalCandidate(opts.roots ?? defaultRoots());
    return hotPath
      ? libraryNeedsRecovery()
      : err("library_not_found", "No supported Engine DJ library was found");
  };

  /**
   * Seeded from the start-time scan and grown by every list_libraries call
   * after: once a candidate path has been read successfully, it stays here.
   * That is what lets rescanLibraries() below keep reporting a library that
   * a later scan catches locked, instead of discoverLibraries() silently
   * dropping it -- the same library that "was discoverable before must not
   * silently disappear because it is momentarily unreadable" (see
   * tools/libraries.ts). Keyed by candidate path rather than uuid: a failed
   * read has no fresh uuid to key on, only the path it was attempted at.
   */
  const knownLibraries = new Map<string, LibraryInfo>(libs.map((l) => [l.path, l]));

  /**
   * The re-scan behind the list_libraries tool. Every candidate path that
   * still exists but failed to read this time is reported using its last
   * known-good LibraryInfo, marked `unreadable` with the fresh error --
   * present, but visibly not fine, rather than absent. A candidate that no
   * longer exists at all (the drive itself is gone) is forgotten instead:
   * that is a real disappearance, not a degraded state.
   */
  const rescanLibraries = (): LibraryEntry[] => {
    const roots = opts.roots ?? defaultRoots();
    const seen = new Set<string>();
    const entries: LibraryEntry[] = [];
    for (const probe of probeLibraries(roots)) {
      seen.add(probe.path);
      if (probe.info) {
        knownLibraries.set(probe.path, probe.info);
        entries.push(probe.info);
      } else {
        const cached = knownLibraries.get(probe.path);
        if (cached) entries.push({ ...cached, unreadable: probe.error! });
      }
    }
    for (const path of knownLibraries.keys()) {
      if (!seen.has(path)) knownLibraries.delete(path);
    }
    return entries;
  };

  /** Every library this server currently knows about, in root-scan order. */
  const knownList = (): LibraryInfo[] => [...knownLibraries.values()];

  /**
   * Per-library state, keyed by the path of `m.db` rather than by uuid:
   * copying a library to another drive copies its uuid too, so uuid is not
   * unique across mounted volumes while the file's location always is.
   */
  const states = new Map<string, LibraryState>();

  /**
   * Sidecars live at `<base>/<uuid>/index.db`, which isolates two libraries
   * from each other -- verified -- for as long as their uuids differ. They
   * do not always differ: a library cloned onto a second drive (a normal
   * thing for a DJ to do) carries the original's uuid, and both would then
   * rebuild over the same index file on every call, thrashing forever.
   *
   * Only the *second and later* claimants of a uuid are moved aside, so the
   * ordinary single-library layout on disk is exactly what it was, and the
   * library that owns the uuid by root-scan order keeps it across restarts.
   */
  const sidecarBaseFor = (lib: LibraryInfo): string | undefined => {
    const first = knownList().find((l) => l.uuid === lib.uuid);
    if (!first || first.path === lib.path) return opts.sidecarBaseDir;
    const tag = createHash("sha256").update(lib.path).digest("hex").slice(0, 12);
    return join(opts.sidecarBaseDir ?? sidecarDir(""), "duplicate-uuid", tag);
  };

  /** Lazily creates -- and thereafter reuses -- one query child per library. */
  const stateFor = (lib: LibraryInfo): LibraryState => {
    const existing = states.get(lib.path);
    if (existing) return existing;
    const qp = new QueryProcess(lib.path, null, 10_000);
    const state: LibraryState = { lib, qp, mgr: new IndexManager(lib, qp, sidecarBaseFor(lib)) };
    states.set(lib.path, state);
    return state;
  };

  /**
   * Turns the optional `library` argument into one specific library.
   *
   * A miss triggers a single re-scan before giving up: `list_libraries`
   * re-discovers on every call precisely so a drive plugged in after this
   * server started is visible, and a library a caller can see but cannot
   * select is the defect this whole argument exists to close. The re-scan
   * runs only on a miss, so the normal path stays a Map lookup.
   */
  const selectLibrary = (requested?: string): LibraryInfo | EngineError => {
    if (requested === undefined) return pickDefaultLibrary(knownList()) ?? noLibraryError();
    const direct = findLibrary(knownList(), requested);
    if (direct) return direct;
    rescanLibraries();
    return findLibrary(knownList(), requested) ?? libraryNotFound(requested, knownList());
  };

  /**
   * `index_stale` is swallowed only when an index is genuinely attached:
   * "the previous index is still in use" is a reason to answer anyway, but
   * "the index could not be built yet" is not. Every tool's SQL joins
   * `side.track_derived`, so letting the call proceed with nothing attached
   * turned the project's headline scenario -- a first run while Engine DJ
   * holds a write lock -- into `invalid_argument` carrying the raw SQLite
   * string "no such table: side.track_derived", instead of `index_stale`
   * with a `retry_after_ms` the model can act on.
   */
  const acquire = async (requested?: string): Promise<LibraryState | EngineError> => {
    const lib = selectLibrary(requested);
    if (isEngineError(lib)) return lib;
    const state = stateFor(lib);
    const fresh = await state.mgr.ensureFresh();
    if (!isEngineError(fresh)) return state;
    if (fresh.error === "index_stale" && state.qp.hasSidecar) return state;
    return fresh;
  };

  /**
   * Shared by the engine://libraries resource and the list_libraries tool so
   * the two cannot drift in shape, while differing in exactly one respect:
   * which library list they are given.
   *
   * The resource is passed the start-time snapshot, which is what the spec
   * claims a resource is. The tool re-discovers on every call, because a
   * USB drive plugged in after the server started is the ordinary case for
   * a DJ, and "restart your assistant to see the drive you just plugged in"
   * is not an answer.
   *
   * index_generation only appears once a sidecar has actually been built at
   * least once in this process -- a never-built IndexManager still reports
   * generation 0, which is not a real generation number and must read as
   * null, not as "generation zero". A library nobody has queried yet has no
   * IndexManager at all and reports null for the same reason: listing the
   * libraries must not fork a query child per drive to fill in a number.
   *
   * Reads each known IndexManager's generation via peekGeneration(), not
   * ensureFresh(): ensureFresh() also rebuilds when the library has
   * changed, which is exactly right for a tool that is about to query the
   * index and exactly wrong here. list_libraries is what a user reaches
   * for when something looks broken, and list_libraries re-scans on every
   * call (see below) -- so making it pay for a first, or renewed, index
   * build on a big or currently-locked library would make the one
   * diagnostic tool that must stay fast the one most likely to block.
   * peekGeneration() only reads the sidecar already on disk, so this stays
   * honest (a real, current generation number, never a fabricated one) and
   * never forces work list_libraries does not itself need to answer.
   */
  const libraryReport = (discovered: LibraryEntry[]) => {
    const generations = new Map<string, number>();
    for (const state of states.values()) {
      const generation = state.mgr.peekGeneration();
      if (generation > 0) generations.set(state.lib.uuid, generation);
    }
    return listLibraries(generations, discovered);
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
    async (uri) => ({ contents: [{ uri: uri.href, text: JSON.stringify(libraryReport(libs), null, 2) }] }),
  );

  server.registerTool(
    "search_tracks",
    {
      title: "Search tracks",
      description:
        "Search the Engine DJ library by text, tempo, key, rating, play history and analysis " +
        "flags. Set include_total for a count alongside the page: it is capped at 1000, and a " +
        "capped result comes back as total: 1000 with total_capped: true -- treat that as " +
        "'at least 1000', never as an exact count. " +
        "flags.has_cues means a hot cue is actually set (the blob is decoded when the index " +
        "is built), not merely that Engine analysed the track; flags.has_beatgrid means a " +
        "beatData blob is present. " +
        LIBRARY_SELECTION_NOTE,
      inputSchema: { ...SearchInput.shape, library: LibraryArg },
      annotations: RO,
    },
    async (args) => {
      const state = await acquire(args.library);
      if (isEngineError(state)) return reply(state);
      return reply(await searchTracks(state.qp, args as any));
    },
  );

  server.registerTool(
    "get_tracks",
    {
      title: "Get tracks by id",
      description:
        "Fetch full metadata for specific track ids, in the order requested. " +
        LIBRARY_SELECTION_NOTE,
      inputSchema: { ...GetTracksInput.shape, library: LibraryArg },
      annotations: RO,
    },
    async (args) => {
      const state = await acquire(args.library);
      if (isEngineError(state)) return reply(state);
      return reply(await getTracks(state.qp, args as any));
    },
  );

  server.registerTool(
    "get_track_performance",
    {
      title: "Get cues, loops and beatgrid",
      description:
        "Decode PerformanceData for one track: hot cues, the main cue, saved loops, the " +
        "beatgrid and a coarse waveform profile. Each field carries its own decode status " +
        "and its own layout marker. " +
        "layout: \"verified\" (cues, beatgrid, waveform_summary) means the binary layout was " +
        "confirmed against a real Engine DJ library -- cue positions land inside the track, " +
        "the beatgrid's implied tempo matches the analysed BPM, and the waveform's declared " +
        "point spacing multiplies back out to the track's sample count -- so status: \"ok\" " +
        "there is a claim about the values, not just about the parse. " +
        "layout: \"unverified\" (loops) still means only that the bytes parsed: the loop slot " +
        "structure is known, but no library was available with a loop actually saved, so " +
        "loop bounds must not be reported to a user as fact. " +
        "Positions are sample offsets; sample_rate at the top level converts them to " +
        "seconds, and cue/loop items carry the seconds already. Only hot-cue and loop slots " +
        "that hold something are listed -- slots is how many the track has in total, so " +
        "items: [] with slots: 8 means an analysed track with no cues set. Items are capped " +
        "at 64; total gives the full count and truncated says whether the cap was hit. " +
        LIBRARY_SELECTION_NOTE,
      inputSchema: { ...PerformanceInput.shape, library: LibraryArg },
      annotations: RO,
    },
    async (args) => {
      const state = await acquire(args.library);
      if (isEngineError(state)) return reply(state);
      return reply(await getTrackPerformance(state.qp, args as any));
    },
  );

  server.registerTool(
    "audit_library",
    {
      title: "Audit the collection",
      description:
        `Run collection health checks. Available: ${AUDIT_CHECKS.join(", ")}. ` +
        `missing_files resolves each track against the selected library's own folder. ` +
        `no_cues means "no hot cue is set" -- the quickCues blob is decoded for this, since ` +
        `Engine writes one to every analysed track whether or not a pad is used -- while ` +
        `no_beatgrid means the beatData blob is absent or empty. ` +
        LIBRARY_SELECTION_NOTE,
      inputSchema: { ...AuditInput.shape, library: LibraryArg },
      annotations: RO,
    },
    async (args) => {
      const state = await acquire(args.library);
      if (isEngineError(state)) return reply(state);
      // state.lib.path, never a captured "primary" path: missing_files
      // resolves every relative Track.path against the grandparent of this
      // argument, so the wrong library's path here would report a wrong
      // answer rather than an error.
      return reply(await auditLibrary(state.qp, state.lib.path, args as any));
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
        "indexes. " +
        LIBRARY_SELECTION_NOTE,
      inputSchema: { ...RunSqlInput.shape, library: LibraryArg },
      annotations: RO,
    },
    async (args) => {
      const state = await acquire(args.library);
      if (isEngineError(state)) return reply(state);
      return reply(await runSql(state.qp, args as any));
    },
  );

  server.registerTool(
    "list_libraries",
    {
      title: "List Engine DJ libraries",
      description:
        "List every discovered library, including ones whose schema is unsupported. " +
        "Re-scans on every call, so a drive plugged in after this server started is visible " +
        "without a restart (the engine://libraries resource is a start-time snapshot). A " +
        "library seen before but not readable right now (e.g. Engine DJ is writing to it) " +
        "stays listed with status: \"unreadable\" and error set, instead of disappearing. " +
        "Pass a listed uuid or path as the `library` argument of any other tool to act on that " +
        "library; without it they use the supported library holding the most tracks.",
      inputSchema: {},
      annotations: RO,
    },
    async () => reply(libraryReport(rescanLibraries())),
  );

  server.registerTool(
    "refresh_index",
    {
      title: "Refresh the search index",
      description: "Rebuild the search index if the library has changed. " + LIBRARY_SELECTION_NOTE,
      inputSchema: { library: LibraryArg },
      annotations: RO,
    },
    async (args) => {
      // Not gated through acquire(): this tool *is* the gate, so it reports
      // ensureFresh's own result rather than swallowing index_stale.
      const lib = selectLibrary(args.library);
      if (isEngineError(lib)) return reply(lib);
      return reply(await refreshIndex(stateFor(lib).mgr));
    },
  );

  /**
   * There was previously no way to shut this down at all: createServer
   * forked a query child and handed back an McpServer whose close() knows
   * only about the transport, so the child outlived every caller -- a leak
   * in tests, and in a host that restarts its MCP servers a leak of one
   * process per restart.
   *
   * close() is wrapped rather than replaced so a client disconnecting
   * through the normal MCP path also releases the children; dispose() is
   * exposed for a caller that owns the server directly. QueryProcess#kill
   * tolerates being called with no live child, so both are idempotent --
   * and it is *every* library's child now, not just the first one, or a
   * session that touched two drives would leak one process per drive.
   */
  const disposeAll = () => {
    for (const state of states.values()) state.qp.dispose();
  };
  const closeTransport = server.close.bind(server);
  server.dispose = disposeAll;
  server.close = async () => {
    try {
      await closeTransport();
    } finally {
      disposeAll();
    }
  };

  return server;
}

const SCHEMA_NOTE = `# Engine DJ library — schema and semantics

Tables live in \`m.db\` (attached as \`main\`); the search index lives in \`side\`.

## Choosing a library
More than one library can be connected at once — the local one under
\`~/Music\` and one per USB drive. \`list_libraries\` reports each with a
\`uuid\` and a \`path\`, and every tool that reads library data
(\`search_tracks\`, \`get_tracks\`, \`get_track_performance\`,
\`audit_library\`, \`run_sql\`, \`refresh_index\`) takes an optional
\`library\` argument naming one of them: either the \`uuid\` or the
\`path\`, in the \`~/...\` form \`list_libraries\` prints or the absolute
one. A value matching neither comes back as \`library_not_found\` listing
the libraries that are selectable.

Omitting \`library\` selects the supported library holding the most tracks,
ties broken by scan order — so an empty local library does not shadow the
populated drive a DJ actually works from. Each library keeps its own search
index, and every query, audit and path resolution stays inside the library
selected for that call; nothing here compares two libraries against each
other.

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
  contains \`..\`. The SQL function \`abs_path(path)\` resolves it against
  this library's location; the home prefix comes back folded to \`~\`.
- Playlists are singly linked lists: order lives in \`Playlist.nextListId\`
  and \`PlaylistEntity.nextEntityId\`, not in any position column.
- A track's natural key across drives is \`(originDatabaseUuid, originTrackId)\`.
- \`PerformanceData\`'s blob columns are binary and cannot be read with SQL.
  Engine writes \`quickCues\`, \`loops\`, \`beatData\` and
  \`overviewWaveFormData\` to **every analysed track** whether or not the DJ
  set anything, so \`quickCues IS NOT NULL\` means "analysed", not "has
  cues": a track with no hot cues still carries a full eight-slot blob.
  \`get_track_performance\` decodes one track's blobs; for the whole library,
  \`side.track_derived.has_cues\` below holds the decoded answer.

## SQL functions
Registered on the query connection, all deterministic:
\`camelot(key)\`, \`key_name(key)\`, \`tempo(bpmAnalyzed, bpm)\`,
\`key_distance(a, b)\` and \`abs_path(path)\`. Each runs a callback per row,
so use them for projection and one-off questions, not in a \`WHERE\` clause
where \`side.track_derived\` is indexed and these are not.

## Sidecar tables
- \`side.fts_track\` — FTS5 over title, artist, album, genre, comment, label,
  with diacritics folded. Join via \`side.fts_map(rowid, track_id)\`.
- \`side.track_derived(track_id, camelot, tempo, has_cues, has_grid)\` — indexed.
  \`has_cues\` is **not** \`quickCues IS NOT NULL\`: the blob is decoded when
  this index is built, and the column means "at least one hot cue is actually
  set". It is the right column for "which tracks have no cues?", and the
  matching \`audit_library\` check is \`no_cues\`. \`has_grid\` does mean "a
  \`beatData\` blob is present and non-empty", which on a real library is the
  same thing as an analysed beatgrid.

## Limits
The connection is read-only at the kernel level, not by convention: writes
are refused by SQLite itself. \`VACUUM\`, \`ATTACH\` and \`DETACH\` are
rejected. Only one statement per call. Queries are killed after 10 seconds.
\`search_tracks\`'s \`total\` (when requested) is capped at 1000; check
\`total_capped\` before treating it as exact.`;
