# engine-dj-mcp

An MCP server that lets an AI assistant search and audit your **Engine DJ**
libraries — the one on your Mac and the ones on your USB drives.

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
  Engine's `PerformanceData`, with a per-field decode status. The cue and
  beatgrid layouts are reverse-engineered but **validated against a real
  Engine library**; the loop layout is not fully validated — see
  [Limitations](#limitations).
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

## Choosing a library

Engine DJ keeps a library on your computer and another on every drive you
export to, so more than one is usually connected at once. `list_libraries`
reports each of them with a `uuid` and a `path`, and **every tool that reads
library data takes an optional `library` argument** — `search_tracks`,
`get_tracks`, `get_track_performance`, `audit_library`, `run_sql` and
`refresh_index`. Pass either the `uuid` or the `path` exactly as
`list_libraries` printed it; the `~/…` form it reports is accepted alongside
the absolute one. A value matching neither comes back as
`library_not_found`, listing the libraries you can actually choose from.

Leave `library` out and the server uses **the supported library holding the
most tracks**, ties broken by the order the drives were scanned in. That
matters: the local library Engine DJ creates on install is scanned first and
is often empty, so "the first one found" would hide the drive you actually
work from.

Each library gets its own search index and its own read-only connection,
opened the first time you ask that library a question — mounting four drives
does not cost four connections. Every query, audit and file-path check stays
inside the library selected for that call. Comparing two libraries against
each other — "what is on this drive but not that one?" — is **not** something
this server does.

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

## Limitations

Read this before deciding what to trust.

- **Cue, beatgrid and waveform layouts are validated; the loop layout is
  not.** The
  binary layouts inside `PerformanceData` are reverse-engineered, so every
  decoded field says which kind it is:

  - `layout: "verified"` — **cues** (including the main cue), the
    **beatgrid**, and the **waveform summary**. These were derived from and
    checked against a real Engine DJ 3.0.x library of 281 analysed tracks:
    cue offsets land inside the track, the beatgrid's implied tempo matches
    `bpmAnalyzed` on all 281, and the waveform's declared point spacing
    multiplies back out to the track's sample count on all 281. A
    `status: "ok"` here is a claim about the values, not just the parse.
  - `layout: "unverified"` — **loops**. The blob's slot structure is known
    (eight slots, uncompressed, little-endian) and an empty one decodes
    correctly, but not one track in that library had a loop saved, so the
    meaning of a *populated* loop slot is untested. Do not report loop
    bounds to a user as fact.

  A `layout` marker is a claim about the **bytes** — which offset holds
  which field, and what the number there means. It is not a claim about
  every name this server puts on them. Three labels are inferred rather than
  measured, and the code says so where each is defined: which of a cue's
  four colour bytes is which channel (they are reported as stored, as one
  32-bit value, with no channel claim attached); that the second beatgrid is
  the one Engine calls "adjusted" (that it is the one Engine *plays* is
  measured — on seven tracks the other grid runs at exactly half the
  analysed tempo); that `main_cue.is_adjusted` is what its flag byte means;
  and that the waveform's three bytes per point are the low, mid and high
  bands in that order. None of these affects a value you get back.

  Everything else the server reports — titles, artists, tempo, key, ratings,
  play history, file paths — is read straight from the database and carries
  no such caveat.
- **`has_cues` and `no_cues` mean "a hot cue is set", and cost a little to
  say so.** Engine writes a `quickCues` blob to every analysed track whether
  or not any pad is used, so the cheap SQL test (`quickCues` present and
  non-empty) answers a question about *analysis*: in the 281-blob reference
  library all 281 would count as having cues, while two tracks (three rows,
  one track being exported to a second library) actually do. The blob is
  therefore decoded when the search index is built, and
  `search_tracks(flags: { has_cues: true })` and `audit_library`'s `no_cues`
  both read the decoded answer. That costs about 100 ms of extra rebuild
  time at 50,000 tracks, and a rebuild only runs when your library changes.

  The track's **main cue** does not count towards it: Engine sets that as a
  playback start marker rather than the DJ placing it (it is set on 159 of
  the 281 blobs, including every track the library records as played), so
  counting it would answer a third question again. `has_beatgrid` and
  `no_beatgrid` do still test for the blob — a `beatData` blob has no
  "written but empty" state, and on all 281 real blobs presence and a usable
  grid have never disagreed.
- **It never writes to your library.** Not to add a cue, not to fix a tag,
  not even to recover a journal Engine DJ left behind. The connection is
  read-only at the kernel level, so a write is refused by SQLite itself
  rather than by a rule this code could get wrong.
- **It does not read play history.** `Track.timeLastPlayed` is used to answer
  "what have I not played in six months?", but the separate Engine history
  database — individual sessions, decks, what followed what — is not opened
  at all.
- **It does not build set lists**, reorder playlists, or suggest transitions.
  It answers questions about the collection; the mixing is yours.
- **Schema 3.0.0 through 3.0.2 only** (Engine DJ 4.5 and 5.x). Older and
  newer libraries are listed with their version and reported as unsupported
  rather than read on a guess.

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
