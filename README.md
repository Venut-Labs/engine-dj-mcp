# engine-dj-mcp

An MCP server that lets an AI assistant search and audit your **Engine DJ**
library.

> **Not affiliated with, endorsed by, or sponsored by inMusic Brands, Denon
> DJ, or the Engine DJ product.** "Engine DJ" is used here only to name the
> software whose library this tool reads. No logos or brand artwork from
> inMusic or Denon DJ are used in this project.

## What it does

- **Smart search** (`search_tracks`) — full text with diacritics folded,
  tempo windows, harmonic key matching, rating, and play history ("what have
  I not played in six months?").
- **Track lookup** (`get_tracks`) — full metadata for specific track ids.
- **Cues, loops and beatgrids** (`get_track_performance`) — decoded from
  Engine's `PerformanceData`, with a per-field decode status.
- **Collection audit** (`audit_library`) — missing files, unanalysed tracks,
  tracks without cues or beatgrids, duplicates, suspicious tempos, orphaned
  playlist entries.
- **Read-only SQL** (`run_sql`) — an escape hatch for anything the tools
  above do not cover.
- **Library and index introspection** (`list_libraries`, `refresh_index`) —
  see what was discovered and force a search-index rebuild.

It also exposes two MCP resources: `engine://schema` (the field semantics an
assistant needs before writing SQL against the library) and
`engine://libraries` (what was discovered, and whether each library's schema
is supported).

## Safety

Your library is opened **read-only at the operating-system level**, not by
convention or by a `PRAGMA` that a query could turn back off. Writes are
refused by SQLite itself, and no file is ever created inside your `Engine
Library` folder. The server keeps its search index in `~/.engine-dj-mcp/`.

`run_sql` accepts arbitrary SQL, but only ever the first statement of it is
executed, and `VACUUM`, `ATTACH` and `DETACH` are rejected outright, so a
chained or exfiltrating statement cannot slip past the read-only connection.

If Engine DJ was closed uncleanly and left an unrecovered journal, this
server will never open the library writably to "fix" it for you — that
would break the one guarantee this project makes. It reports
`library_needs_recovery` instead and asks you to launch Engine DJ once so it
can recover the library itself.

## Requirements

- Node.js 22 or newer
- Engine DJ with library schema 3.0.0–3.0.2 (Engine DJ 4.5 and 5.x)

## Install

```bash
npx engine-dj-mcp
```

Claude Desktop configuration:

```json
{
  "mcpServers": {
    "engine-dj": { "command": "npx", "args": ["-y", "engine-dj-mcp"] }
  }
}
```

## Licence

MIT — see [LICENSE](./LICENSE).
