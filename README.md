# engine-dj-mcp

[![npm](https://img.shields.io/npm/v/engine-dj-mcp)](https://www.npmjs.com/package/engine-dj-mcp)
[![licence](https://img.shields.io/npm/l/engine-dj-mcp)](./LICENSE)

An MCP server that lets an AI assistant search and audit your **Engine DJ**
libraries — the one on your computer and the ones on your USB drives.

> **Not affiliated with, endorsed by, or sponsored by inMusic Brands, Denon
> DJ, or the Engine DJ product.** "Engine DJ" is used here only to name the
> software whose library this tool reads. No logos or brand artwork from
> inMusic or Denon DJ are used in this project.

Your library is opened **read-only at the operating-system level**. It is
never written to — see [Safety](#safety).

## What you can ask

Once connected, these are ordinary questions in chat:

- *"Something dark around 124 in a minor key I haven't played in six months."*
- *"Which tracks still have no hot cue set?"*
- *"Find me anything harmonically compatible with 8A between 138 and 142."*
- *"What's broken in my collection — missing files, duplicates, bad tempos?"*
- *"Where are the cue points on this track, and what tempo did Engine analyse?"*

## Install

```bash
npx engine-dj-mcp
```

Claude Desktop — add to your configuration:

```json
{
  "mcpServers": {
    "engine-dj": { "command": "npx", "args": ["-y", "engine-dj-mcp"] }
  }
}
```

**Requirements:** Node.js 22.13 or newer (for the unflagged `node:sqlite`;
there are no native dependencies), and an Engine DJ library at schema 3.0.0
through 3.0.2 — Engine DJ 4.5 and 5.x.

## Tools

Seven tools, all read-only. Every tool that reads library data also accepts
an optional `library` argument — see [Choosing a library](#choosing-a-library).

### `search_tracks`

The main one. Full-text search with diacritics folded, plus filters for
tempo, key, rating, when a track was added and when it was last played.

| Argument | What it does |
| --- | --- |
| `q` | Full text over title, artist, album, genre, comment and label. Diacritics are folded, so `bjork` matches `Björk` — Engine's own search does not. |
| `bpm` | `{ min, max }` or `{ around, tolerance_pct }`. Resolved tempo, so an analysed BPM wins over the tag. |
| `key` | `{ camelot: [...] }` for exact keys, `{ compatible_with: "8A" }` for harmonic neighbours, `{ mode: "minor" }` for a whole side of the wheel. |
| `rating` | `{ min, max }`, 0–5. |
| `played` | `{ never: true }`, or `{ before, after }` taking an ISO date or a relative form like `-6 months`. |
| `added` | `{ before, after }`, same date forms. |
| `flags` | `analyzed`, `available`, `has_cues`, `has_beatgrid`. `has_cues` means a hot cue is genuinely set — see [Limitations](#limitations). |
| `fields` | Which columns to return. Defaults to `id, artist, title, bpm, camelot, rating`. |
| `limit`, `cursor` | Page size (default 25, max 200) and an opaque cursor for the next page. |
| `include_total` | Off by default because counting costs far more than the page. Capped at 1000 — a capped result carries `total_capped: true` and means "at least 1000". |

### `get_tracks`

Full metadata for specific track ids, returned in the order you asked for.
Unknown ids are omitted rather than failing the call.

`ids` (required), `fields`, `redact_paths`.

### `get_track_performance`

Decodes the binary `PerformanceData` Engine stores per track: hot cues, the
main cue, saved loops, the beatgrid, and a coarse waveform profile.

Every field carries its own decode status **and** its own `layout` marker.
`layout: "verified"` means the byte layout was confirmed against a real
library, so `status: "ok"` is a claim about the values. `layout: "unverified"`
means only that the bytes parsed. Read [Limitations](#limitations) before
trusting loop bounds.

Positions are sample offsets; cue and loop items also carry seconds.
`items: []` with `slots: 8` means an analysed track with no cues set.

`id` (required).

### `audit_library`

Ten collection health checks. Returns a count and a small sample of ids per
check, never the full result set — a library with thousands of unanalysed
tracks should not fill an assistant's context.

| Check | Finds |
| --- | --- |
| `missing_files` | Tracks whose file is gone from disk |
| `unavailable` | Tracks Engine has marked unavailable |
| `unanalyzed` | Tracks Engine has not analysed |
| `no_cues` | Tracks with no hot cue set |
| `no_beatgrid` | Tracks with no beatgrid data |
| `missing_key` | Tracks with no key detected |
| `suspicious_bpm` | Analysed and tagged tempo disagree, or tempo is outside 60–200 |
| `duplicates` | Same artist and title, or same size and length |
| `empty_metadata` | No artist or no title |
| `orphan_entries` | Playlist entries pointing at tracks that no longer exist |

`checks` — omit it to run all ten.

### `run_sql`

An escape hatch for questions the tools above do not cover. Read-only is
enforced by the kernel, not by this tool. Results are bounded whatever the
query says.

Prefer `side.track_derived.camelot` and `side.track_derived.tempo` in `WHERE`
clauses over the `camelot()` and `tempo()` SQL functions — the functions run
per row and defeat the indexes.

`sql` (required), `params`, `limit`.

### `list_libraries`

Every library found, including ones whose schema is unsupported — listed
with their version, so you can tell a broken server from a missing library.
Re-scans on every call, so a drive plugged in after the server started shows
up without a restart. A library that is temporarily unreadable — Engine DJ
writing to it, say — stays listed with `status: "unreadable"` rather than
vanishing.

No arguments.

### `refresh_index`

Rebuilds the search index if the library changed. Normally unnecessary; the
server checks staleness itself before answering.

## Resources

- **`engine://schema`** — the field semantics an assistant needs before
  writing SQL: how Engine encodes musical key, why tempo is
  `COALESCE(bpmAnalyzed, bpm)`, that `Track.path` is relative, and which
  helper columns are indexed.
- **`engine://libraries`** — what was discovered at startup and whether each
  library's schema is supported. A snapshot; `list_libraries` is the live view.

## Choosing a library

Engine DJ keeps a library on your computer and another on every drive you
export to, so more than one is usually connected. `list_libraries` reports
each with a `uuid` and a `path`, and every tool that reads library data takes
an optional `library` argument. Pass either form exactly as printed — the
`~/…` path is accepted alongside the absolute one. A value matching neither
comes back as `library_not_found`, listing what you can choose from.

Leave it out and the server uses **the supported library holding the most
tracks**. That matters: the local library Engine DJ creates on install is
scanned first and is often empty, so "the first one found" would hide the
drive you actually work from.

Each library gets its own index and its own connection, opened the first time
you ask that library something. Comparing two libraries against each other —
*"what is on this drive but not that one?"* — is **not** something this server
does.

## Safety

Your library is opened **read-only at the operating-system level**, not by
convention and not by a `PRAGMA` a query could turn back off. Writes are
refused by SQLite itself, and no file is ever created inside your `Engine
Library` folder. The search index lives in `~/.engine-dj-mcp/`.

`run_sql` accepts arbitrary SQL, but only the first statement is ever
executed, and `VACUUM`, `ATTACH` and `DETACH` are rejected outright, so a
chained or exfiltrating statement cannot slip past the read-only connection.

If Engine DJ was closed uncleanly and left an unrecovered journal, this
server will not open the library writably to "fix" it — that would break the
one guarantee this project makes. It reports `library_needs_recovery` and
asks you to launch Engine DJ once so it can recover its own library.

## Limitations

Read this before deciding what to trust.

**Loop bounds are not validated.** The layouts inside `PerformanceData` are
reverse-engineered, so every decoded field says which kind it is. Cues, the
beatgrid and the waveform are marked `layout: "verified"` — derived from and
checked against a real Engine DJ 3.0.x library of 281 analysed tracks, where
cue offsets land inside the track, the beatgrid's implied tempo matches
`bpmAnalyzed` on all 281, and the waveform's declared point spacing
multiplies back out to the track's sample count on all 281. Loops are marked
`layout: "unverified"`: the slot structure is known and an empty slot decodes
correctly, but no available library had a loop saved, so a *populated* slot is
untested. **Do not report loop bounds to a user as fact.**

A `layout` marker is a claim about the bytes, not about every name put on
them. Four labels are inferred rather than measured, and the code says so
where each is defined: which of a cue's four colour bytes is which channel
(they are returned as stored, one 32-bit value, with no channel claim); that
the second beatgrid is the one Engine calls "adjusted" (that it is the one
Engine *plays* is measured — on seven tracks the other runs at exactly half
the analysed tempo); that `main_cue.is_adjusted` is what its flag byte means;
and that the waveform's three bytes per point are low, mid and high in that
order. None affects a value you get back.

Everything else — titles, artists, tempo, key, ratings, play history, file
paths — is read straight from the database and carries no such caveat.

**`has_cues` and `no_cues` mean "a hot cue is set".** Engine writes a
`quickCues` blob to every analysed track whether or not a pad is used, so the
cheap SQL test would answer a question about *analysis* instead: in the
reference library all 281 blobs would count as having cues, while two tracks
actually do. The blob is therefore decoded while the index is built. That
costs roughly 100 ms extra at 50,000 tracks, and only when your library
changes. The track's **main cue** does not count towards it — Engine sets
that as a playback marker rather than the DJ placing it. `has_beatgrid` does
still test for the blob: `beatData` has no "written but empty" state.

**It never writes to your library.** Not to add a cue, not to fix a tag, not
even to recover a journal Engine DJ left behind.

**It does not read play history.** `Track.timeLastPlayed` answers "what have I
not played in six months?", but the separate Engine history database —
sessions, decks, what followed what — is not opened at all.

**It does not build set lists**, reorder playlists, or suggest transitions. It
answers questions about the collection; the mixing is yours.

**Schema 3.0.0 through 3.0.2 only.** Older and newer libraries are listed with
their version and reported as unsupported rather than read on a guess.

## Licence

MIT — see [LICENSE](./LICENSE).
