# engine-dj-mcp

[![CI](https://github.com/Venut-Labs/engine-dj-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Venut-Labs/engine-dj-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/engine-dj-mcp)](https://www.npmjs.com/package/engine-dj-mcp)
[![licence](https://img.shields.io/npm/l/engine-dj-mcp)](./LICENSE)

An MCP server that gives an AI assistant your **Engine DJ** libraries — the
one on your computer and the ones on your USB drives. It searches and audits
them, reads the cues and beatgrids Engine stored, and builds playlists when
you ask it to.

> **Not affiliated with, endorsed by, or sponsored by inMusic Brands, Denon
> DJ, or the Engine DJ product.** "Engine DJ" is used here only to name the
> software whose library this tool reads and writes. No logos or brand
> artwork from inMusic or Denon DJ are used in this project.

Your library is opened **read-only at the operating-system level**. It is
never written to unless you start the server with `--allow-writes` — see
[Safety](#safety).

## What you can ask

Once connected, these are ordinary questions in chat:

- *"Something dark around 124 in a minor key I haven't played in six months."*
- *"Which tracks still have no hot cue set?"*
- *"Find me anything harmonically compatible with 8A between 138 and 142."*
- *"What's in my ACID Beach playlist, in order?"*
- *"Anything around 128 in ACID Beach?"*
- *"What's broken in my collection — missing files, duplicates, bad tempos?"*
- *"Where are the cue points on this track, and what tempo did Engine analyse?"*
- *"Build me a playlist of everything in 5A from 140 BPM up."* (needs `--allow-writes`)

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

To let the assistant create playlists as well, add `--allow-writes` — a flag
in `args` rather than an environment variable precisely so it is visible in
the configuration you are reading:

```json
{
  "mcpServers": {
    "engine-dj": { "command": "npx", "args": ["-y", "engine-dj-mcp@0.16.0", "--allow-writes"] }
  }
}
```

Pin the version in this one. Unpinned, `npx` fetches whatever is newest at
every launch, and this configuration gives that code write access to your
library. Pinned, a new release reaches it only when you change the number.

**Requirements:** Node.js 22.16 or newer (`node:sqlite` stopped needing a
flag in 22.13, but the pre-write snapshot uses its `backup()`, added in
22.16;
there are no native dependencies), and an Engine DJ library at schema 3.0.0
through 3.0.2 — Engine DJ 4.5 and 5.x.

## Tools

Nine read-only tools, and four that write — `create_playlist`,
`add_tracks_to_playlist`, `remove_tracks_from_playlist` and
`reorder_playlist` — that appear only when you start the server with
`--allow-writes`. Every tool that reads library data also accepts an
optional `library` argument — see [Choosing a library](#choosing-a-library).

### `search_tracks`

The main one. Full-text search with diacritics folded, plus filters for
tempo, key, rating, when a track was added and when it was last played.

| Argument | What it does |
| --- | --- |
| `q` | Full text over title, artist, album, genre, comment and label. Diacritics are folded, so `bjork` matches `Björk` — Engine's own search does not. |
| `bpm` | `{ min, max }` or `{ around, tolerance_pct }`. Resolved tempo, so an analysed BPM wins over the tag. |
| `key` | `{ camelot: [...] }` for exact keys, `{ compatible_with: "8A" }` for harmonic neighbours, `{ mode: "minor" }` for a whole side of the wheel. |
| `rating` | `{ min, max }`, in stars, 0–5. Engine stores 0, 20, 40, 60, 80, 100; the filter converts, so `{ min: 4 }` means four stars and up. The `rating` field hands back the stored number, and `rating_stars` the same thing in stars. |
| `played` | `{ never: true }`, or `{ before, after }` taking an ISO date or a relative form like `-6 months`. |
| `added` | `{ before, after }`, same date forms. |
| `flags` | `analyzed`, `available`, `has_cues`, `has_beatgrid`. `has_cues` means a hot cue is genuinely set — see [Limitations](#limitations). |
| `playlist` | `{ id }` or `{ name }` — search inside one playlist. Results still come back by relevance or id; `get_playlist_tracks` is what preserves playlist order. |
| `fields` | Which columns to return. Defaults to `id, artist, title, bpm, camelot, rating`. |
| `limit`, `cursor` | Page size (default 25, max 200) and an opaque cursor for the next page. |
| `include_total` | Off by default because counting costs far more than the page. Capped at 1000 — a capped result carries `total_capped: true` and means "at least 1000". |

### `get_tracks`

Full metadata for specific track ids, returned in the order you asked for.
Unknown ids are omitted rather than failing the call.

`ids` (required), `fields`, `redact_paths`.

### `get_playlists`

Your playlist tree, in the order Engine DJ shows it — folders included.

The list is flat and in the order you would read down the sidebar with every
folder expanded: `depth` and `path` carry the nesting, `parent_id` names the
folder a list sits in.

| Field | Meaning |
| --- | --- |
| `name`, `id`, `path` | `path` is the full `Folder/Sub/Name`, and is unique — a bare `name` need not be. |
| `depth`, `parent_id` | The nesting. `parent_id` is `null` at the top level. |
| `is_folder` | The list has child lists. Engine has no folder flag — a folder *is* a playlist that other playlists sit under — so an emptied folder reads as an empty playlist. |
| `is_persisted` | Engine's own flag for a list saved to the device. Both values appear on lists Engine displays, so nothing is filtered on it. |
| `track_count` | Entries in that list alone, never rolled up from its children — the number Engine shows beside it. |
| `missing_count` | How many of those entries name a track this library does not have. |

`limit` (default 200, max 1000). `warnings` appears if a playlist's link
chain is damaged; nothing is ever dropped from the list because of one.

### `get_playlist_tracks`

The tracks of one playlist, **in playlist order**.

Name it with `playlist_id` or with `playlist_name` — exactly one of the two.
Playlist names are unique only within a folder, so a name matching more than
one is refused with every candidate's id and full path rather than guessed
at; pass the `path` from `get_playlists` to say which you meant.

Every row carries `position`, its 1-based place in the playlist. Same
`fields`, `limit` and `cursor` conventions as `search_tracks`.

An entry whose track is not in this library keeps its slot and comes back as
`{ position, entry_id, track_id, missing: true }`, with `missing_count`
alongside `entry_count`. That is ordinary rather than corruption — playlist
entries outlive their tracks and travel between drives — and they are kept in
place so the number of rows still matches the playlist's own length. On one
reference library a 43-entry playlist holds exactly one track that library
can actually play.

### `get_track_performance`

Decodes the binary `PerformanceData` Engine stores per track: hot cues, the
main cue, saved loops, the beatgrid, and a coarse waveform profile.

Every field carries its own decode status **and** its own `layout` marker.
`layout: "verified"` means the byte layout was confirmed against a real
library, so `status: "ok"` is a claim about the values. `layout: "unverified"`
would mean only that the bytes parsed; no field returns it today.

Positions are sample offsets; cue and loop items also carry seconds.
`items: []` with `slots: 8` means an analysed track with no cues set.

`id` (required).

### `audit_library`

Eleven collection health checks. Returns a count and a small sample of ids per
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
| `duplicates` | Same artist and title, compared regardless of case in any script |
| `empty_metadata` | No artist or no title |
| `orphan_entries` | Playlist entries pointing at tracks not in this library — `get_playlist_tracks` shows where each one sits |
| `path_form_mismatch` | The file is on disk, but its name there — or a folder's on the way — is in a different Unicode form from the path Engine stored. macOS finds it anyway; Linux does not (measured on the kernel's exFAT driver), and Engine OS on a player is Linux, so these may fail to load on hardware. Differences in case alone are not counted: exFAT and Windows ignore case |

`checks` — omit it to run all eleven.

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

### `create_playlist`

The first of the four tools that write, none of which is registered at all
unless the server was started with `--allow-writes`.

Creates one new top-level playlist from track ids — `track_ids` sets both
what is in it and the order it is in, so a list built by `search_tracks`
arrives in Engine DJ in the order the assistant chose. Nothing else changes:
no playlist is renamed, reordered, emptied or deleted, and no track, cue or
beatgrid is touched. The one existing row that moves is the previous last
playlist's link, and Engine's own insert trigger is what moves it.

| Argument | What it does |
| --- | --- |
| `title` | Name of the new playlist. Must not already be taken at the top level — Engine allows one name per folder. |
| `track_ids` | Ids from `search_tracks` or `get_tracks`, in playlist order. May be empty, for an empty playlist. A track may appear at most once, which is Engine's own rule. |

Each entry stores the track's origin identity — `(originDatabaseUuid,
originTrackId)`, the pair Engine matches on — not the local row id, so a
playlist built here reads the same way Engine's own does.

The result carries `playlist_id`, `tracks_added`, `library` and `backup_path`. **To undo
it, delete the playlist in Engine DJ**; `backup_path` is a whole-library
snapshot for the case where something went wrong at a lower level, not an
undo — see [Restoring a snapshot](#restoring-a-snapshot).

Its own refusals: `playlist_exists` for a taken title, `unknown_track` for an
id this library does not have, `duplicate_track` for the same id twice — plus
the ones [every write tool shares](#refusals-every-write-tool-shares).

### `add_tracks_to_playlist`

Adds one or more tracks to an **existing** playlist — this edits that
playlist's contents, it does not create a new one (`create_playlist` does
that). If the playlist's entry chain is already damaged, the write is
refused outright rather than repaired, and nothing is added.

A playlist that is a **folder** (`is_folder: true` — it has child lists) is
edited like any other: Engine has no separate folder type, a folder can hold
entries of its own, and all three edit tools add to, remove from and reorder
those entries without complaint. The lists inside it are untouched either
way.

| Argument | What it does |
| --- | --- |
| `playlist_id` / `playlist_name` | Exactly one of the two, resolved the same way `get_playlist_tracks` does: a name matching more than one playlist is refused with every candidate's id and full path listed, not guessed at. |
| `track_ids` | Ids from `search_tracks` or `get_tracks`, in the order they should appear. A track already in the playlist is refused as `duplicate_track` — Engine allows a track in a playlist only once. |
| `at` | Where the new tracks land, against the playlist's current 1-based positions (the same numbering `get_playlist_tracks` reports): `"start"`, `"end"` (the default), or `{ after_position: n }`. |

The result carries `playlist_id`, `tracks_added`, `positions` — where the
new tracks landed — `undo`, `undo_complete` (always `true` here), `library`
and `backup_path`. `undo` is the exact `remove_tracks_from_playlist` call that
reverses this edit: the positions the tracks landed at, plus
`expect_track_ids` naming the tracks that landed there, so a playlist
something else changed in the meantime is refused rather than having the
wrong rows removed. Call it to undo rather than restoring `backup_path` —
see [Restoring a snapshot](#restoring-a-snapshot), and
[An undo covers one library](#an-undo-covers-one-library) for what it does
not reach. Its own refusals: `playlist_not_found`, `playlist_chain_damaged`,
`invalid_position`, and `unknown_track` / `duplicate_track` as for
`create_playlist` — plus the ones
[every write tool shares](#refusals-every-write-tool-shares).

### `remove_tracks_from_playlist`

Removes one or more tracks from an **existing** playlist by position — this
edits that playlist's contents; it never touches any other playlist. If the
entry chain is already damaged, the write is refused outright rather than
repaired.

| Argument | What it does |
| --- | --- |
| `playlist_id` / `playlist_name` | Exactly one of the two, resolved the same way `get_playlist_tracks` does. |
| `positions` | 1-based positions `get_playlist_tracks` reports for this playlist right now. Includes entries whose track is missing from the library (`missing: true`) — removing one is a legitimate way to clean up a hole, and the one removal `undo` cannot reverse (see below). |
| `expect_track_ids` | Optional, one entry per position: verifies each named position still holds the track expected before anything is removed, refusing the whole call otherwise. `null` means "this position should hold an entry whose track is missing", not "no expectation". |

The result carries `playlist_id`, `tracks_removed`, `removed` — each
position's `track_id`, `null` for a missing one — `undo`, `undo_complete`,
`library` and `backup_path`. `undo` is a **sequence** of `add_tracks_to_playlist` calls,
one per removed track that can be restored. Run them in the order given,
never in parallel and never reversed — each step's target position is
computed against the list as it stands after the previous step has already
run, so firing them out of order puts tracks back in the wrong places.
Preferred over restoring `backup_path` for the same reason as above.

`undo_complete` is `false` when the removal included an entry whose track is
missing from the library: that entry named a track this library does not
have, so no `add_tracks_to_playlist` call can put it back, and an
`undo_note` names those positions. The steps that are returned still run and
still restore everything else; the missing entries are recoverable only from
`backup_path`, which reverts the whole library.

Its own refusals: `playlist_not_found`, `playlist_chain_damaged`, and
`invalid_position` — for a repeated or out-of-range position, or one that
does not hold what `expect_track_ids` expected — plus the ones
[every write tool shares](#refusals-every-write-tool-shares).

`playlist_chain_damaged` always means the same thing for all three edit
tools: the playlist's entry chain was already broken **before** the edit,
which is why the edit refused to touch it. If instead the check each edit
runs on its own work disagrees — the chain did not read back as it was
written — the transaction is rolled back and that comes back as
`library_unreadable`, with `detail: "not_committed"`. Both leave the library
exactly as it was; only the second one is this server saying it does not
understand what the library just did.

### `reorder_playlist`

Reorders an **existing** playlist's tracks — this changes the order of that
playlist's existing entries; it adds nothing and removes nothing. If the
entry chain is already damaged, the write is refused outright rather than
repaired.

| Argument | What it does |
| --- | --- |
| `playlist_id` / `playlist_name` | Exactly one of the two, resolved the same way `get_playlist_tracks` does. |
| `order` | A full permutation of `1..n`, `n` being the playlist's current entry count. `order[i]` names the *current* 1-based position (from `get_playlist_tracks`) of the track that should end up at position `i + 1`. A partial "move x to y" instruction is not accepted — name every position, including ones that do not move. |

The result carries `playlist_id`, `undo`, `undo_complete` (always `true`
here), `library` and `backup_path`. `undo` is the exact inverse permutation, as a single
`reorder_playlist` call. Its own refusals: `playlist_not_found`,
`playlist_chain_damaged`, and `invalid_position` if `order` is not a full
permutation of the playlist's current positions — plus the ones
[every write tool shares](#refusals-every-write-tool-shares).

Reordering to the order a playlist is already in is accepted and rewrites no
entry: it still stamps the playlist's `lastEditTime`, and still costs this
session's snapshot if nothing had been written yet.

### `update_track_metadata`

Changes genre, comment, label, year or rating on tracks — the values Engine
DJ shows in its columns. It writes to Engine's database, **not to the audio files' tags**. Engine itself writes a comment into the file when you edit it
there, but not a genre or a rating, so other software reading the tags will
not see these edits either way.

| Argument | |
| --- | --- |
| `updates` | Up to 200 entries, each `{ id, genre?, comment?, label?, year?, rating_stars? }`. Only the named fields change. `""` clears a text field; `year: 0` means unknown, as Engine stores it; `rating_stars` is 0–5. |
| `library` | Required when more than one library is connected — see [Choosing a library](#choosing-a-library). |

A track that already holds the requested values is not written, so repeating
a call changes nothing; it is counted in `unchanged`. The result carries
`updated`, `unchanged`, `changed` — which fields changed on which tracks —
`undo`, `undo_complete` (always `true`), `library`, and `backup_path` when
anything was written.

**Undo.** `undo` is one `update_track_metadata` call that restores the
previous values of exactly the fields that changed, and names the library.
It restores values, not `lastEditTime`: Engine's own trigger stamps every
edit, the undo included. Each entry carries `expect` set to what this call
wrote, so an undo replayed after someone edited the track again is refused as
`stale_value` instead of overwriting that edit. `rating_raw` and `expect`
exist for this; an ordinary edit needs neither.

Keep the undo from the first response. Repeating a call that already went
through finds nothing to change and returns an empty undo. For work spread
over several calls, replay the undos in reverse order.

Its own refusals: `unknown_track`; `track_not_editable` — a track whose origin
is empty (Engine's trigger rewrites an empty origin on any update, which would
detach it from playlist entries on other drives), or a field holding a value
this tool could not put back, such as a rating outside 0–255; `stale_value`,
listing every `expect` that no longer matched in a structured `mismatches`
field; and `invalid_argument`. Plus the ones
[every write tool shares](#refusals-every-write-tool-shares), except
`index_stale` and the query errors: this tool addresses tracks by id and never
touches the search index.

**Searching right after an edit.** Genre, comment and label are in the search
index, which is rebuilt on the next read. While Engine DJ holds the library
open it cannot be rebuilt, so a search can keep showing the old values, and
`refresh_index` cannot help until Engine lets go. The edit itself is in the
database.

**Smart playlists.** A smart playlist whose rules match on genre changes what
it contains when a genre is renamed, though none of its own rows were touched.

### Refusals every write tool shares

These come from what happens before the write itself — choosing the library,
bringing its index up to date, resolving the playlist — and from the write's
own checks.

| Code | Means | Nothing written? |
| --- | --- | --- |
| `invalid_argument` | The arguments do not make sense — both `playlist_id` and `playlist_name`, an empty list where one is required, or a `playlist_name` that matches several playlists (every candidate is listed). | yes |
| `library_not_found` | `library` names nothing connected — the refusal lists what is — or the library's header could not be read. | yes |
| `ambiguous_library` | No `library` given, and more than one supported library is connected. Lists them — see [Choosing a library](#choosing-a-library). | yes |
| `unsupported_schema` | The library's version is outside what this server supports. | yes |
| `library_needs_recovery` | Engine DJ left an unrecovered journal. Launch Engine once. | yes |
| `library_busy` | Something holds a conflicting lock right now. Retry. | yes |
| `index_stale` | The index could not be built yet, typically because Engine holds a lock on a first run. Carries `retry_after_ms`. | yes |
| `query_timeout`, `query_process_crashed` | The lookup that resolves a playlist failed. Edit tools only. | yes |
| `library_unreadable` | The library could not be read; the snapshot taken before the first write could not be made (a full disk, or a Node older than 22.16); or a write's own read-back disagreed with what it wrote, and it was rolled back. | see `detail` |

**`detail` on these errors.** Once the write itself has started, `detail` is
exactly one of two strings, and a client can read it to decide whether the
library changed: `not_committed` — the library is what it was — or
`committed_unverified` — the rare one: the write may have landed but could not
be confirmed, and only this case hands back a `backup_path`. Refusals raised
*before* that point — every row above marked "yes" — never opened the library
for writing, whatever their `detail` says: it may be absent, `not_committed`,
or explanatory text such as the candidates an ambiguous `playlist_name` lists.

## Resources

- **`engine://schema`** — the field semantics an assistant needs before
  writing SQL: how Engine encodes musical key, why tempo is
  `COALESCE(bpmAnalyzed, bpm)`, that `Track.path` is relative, where playlist
  order really lives, and which helper columns are indexed.
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

That rule is enough for a read, which changes nothing: with two libraries
connected a read picks one, and the `library` field in the result says which.

**A write refuses instead**, as soon as more than one supported library is
connected — whatever their track counts. `ambiguous_library` lists every
candidate with its track count, and `detail: "not_committed"`.

The count was never the right question. An earlier version refused only an
exact tie, reasoning that a USB drive and its copy tie precisely because one
is a copy of the other — measured 2026-09-01, both real libraries at 257. But
import one track on one side and the tie is gone, and the default quietly
takes the larger. A playlist written to the wrong drive is at least visible
there; a track's genre is not, and you are left believing the edit did not
work.

With a single library nothing changes: you never have to name it.

The refusal tells the assistant to **ask you** rather than choose. Otherwise
"pass `library`, here are the two" is an invitation to take the first one,
which puts the write back on an arbitrary disk and makes the refusal
pointless.

Each library gets its own index and its own connection, opened the first time
you ask that library something. Comparing two libraries against each other —
*"what is on this drive but not that one?"* — is **not** something this server
does.

## Safety

Your library is opened **read-only at the operating-system level**, not by
convention and not by a `PRAGMA` a query could turn back off. Writes are
refused by SQLite itself, and without `--allow-writes` no file is ever
created inside your `Engine Library` folder. The search index lives in
`~/.engine-dj-mcp/`.

### Writing

Without `--allow-writes` the server has no tool that can write, and the
paragraph above holds exactly as written: SQLite itself refuses.

With the flag, five tools appear. `create_playlist` adds a new playlist and
nothing else. `add_tracks_to_playlist`, `remove_tracks_from_playlist` and
`reorder_playlist` go further: with the flag, an **existing** playlist can
now be changed, not only created — its tracks added to, removed from, or put
in a different order. `update_track_metadata` changes tags on tracks themselves — see its section above. What each one touches is the named playlist's own
entries, plus exactly two rows elsewhere: that playlist's own row, whose
`lastEditTime` every edit stamps so Engine sees the change, and — for
`create_playlist` only — the previous last playlist's link, made by Engine's
own insert trigger. No other playlist is renamed, emptied or deleted, and no
track, cue or beatgrid is touched by any of the five.

Every edit returns `undo` — the exact tool call that reverses it, expressed
against the positions the edit itself produced — and `undo_complete`, saying
whether replaying it puts the playlist back exactly as it was. Replaying
`undo` is the right way back from an edit; restoring `backup_path` is not,
because it reverts the **whole library** to before this session's first
write, discarding every play count, import, cue and beatgrid change Engine
DJ has recorded since, along with the one edit you actually wanted undone.
See [Restoring a snapshot](#restoring-a-snapshot).

There is exactly one edit `undo` cannot reverse, and it says so rather than
pretending otherwise: removing an entry whose track is missing from the
library (`missing: true`). Such an entry names a track this library does not
have, so there is no track id to add back — the result comes back with
`undo_complete: false` and an `undo_note` naming those positions, and the
steps it does return still restore everything else.

Before the first write of a session the database is snapshotted to
`~/.engine-dj-mcp/backups/`, and every write of that session returns its
path. Ten snapshots are kept per library — per library *file*, so a library
and its clone on another drive do not share the ten.

One file *is* created inside your `Engine Library` folder while a write is in
progress: SQLite's rollback journal, `m.db-journal`, next to `m.db`. It is
removed when the transaction commits, and it is what makes the write
all-or-nothing. If the process is killed mid-transaction the journal is left
behind, and both this server and Engine DJ then treat the library as needing
recovery — this server reports `library_needs_recovery` and refuses to touch
the library, including for reads, until you have launched Engine DJ once so
it can roll the journal back. Nothing else is ever written in that folder,
and without `--allow-writes` not even this.

The write takes SQLite's own write lock for the length of one transaction and
does not wait for it: if something else — Engine DJ mid-save, a player — is
holding a conflicting lock at that moment, the write is refused with
`library_busy` and nothing is changed.

**Quit Engine DJ before writing.** Having Engine open is not usually a lock
conflict, so the write itself will normally go through — but what Engine then
does with a change made underneath it has never been measured here. Every
acceptance check of a write was run with Engine closed. What *has* been
measured is that Engine does its own work on the library as it loads: it
renumbers playlist entries, and it copies playlist changes to another
connected library (see below). Quit, write, relaunch — Engine reads the
library on startup and shows the change.

Quit, not close. On macOS, closing Engine's window leaves the application
running: observed 2026-09-01 with the main process and seven
`OfflineAnalyzer` workers — which write to the database — still alive
afterwards. Use ⌘Q.

### An undo covers one library

Every write result carries a `library` field — the `uuid` and `path` of the
library the write actually landed in. Two libraries connected at once is the
ordinary setup: a USB drive and its copy on the computer. This is where you
check which of them a write went to.

**`undo` reverses the edit in that one library, and only there.** Each undo
step names it — by path, in the step's own `library` argument — so replaying
a step verbatim goes back to the library the edit was made in, not to whatever
the default is at replay time. That matters because a USB drive and its copy
hold the same playlist ids and the same track ids: a replay that resolved the
default could land on the wrong disk, and its `expect_track_ids` would agree,
both sides having been edited the same way.

Engine DJ moves playlist changes between connected libraries by itself, so a
copy of your edit can still end up somewhere `undo` cannot reach.

Measured 2026-09-01. A track was added to a playlist in the library on the
computer. Engine DJ was then launched with the USB drive attached, and the
same playlist on the USB came back with the same track added — the copy
carrying the very `lastEditTime` this server's `INSERT` had written. The
`undo` was then run and reversed the edit on the computer. The USB kept it.

Nothing was damaged: both libraries stayed sound. But the two had diverged,
and the `undo` reported success, correctly, because within its own library it
did exactly what it promised.

So: if a second library is connected, look at the `library` field, and undo
against each library separately. Undoing before Engine DJ next runs avoids
the problem entirely.

Which library a change propagates to, and in which direction, is Engine's own
business — this project does not model it and will not guess at it.

### Restoring a snapshot

`backup_path` is not an undo. It is a copy of the **whole** `m.db` from
before the session's first write, so putting it back reverts the entire
library to that moment: every play count, import, cue, beatgrid and rating
Engine DJ has written since is discarded along with the one edit you wanted
gone. Reach for it only if the library itself is damaged — the case where a
write comes back with `detail: "committed_unverified"`.

Snapshots live in `~/.engine-dj-mcp/backups/`, ten per library. Only a name
ending in `.db` is a snapshot. A file ending in `.partial-<number>` — with or
without `-journal` after it — is a copy still being written, or one whose
process died before it finished: **never restore one of those**. A copy is
renamed to its `.db` name only once it is complete, and an abandoned one is
cleared the next time that library is snapshotted.

**To undo a playlist you created, delete it in Engine DJ.** Engine's own
delete trigger repairs the playlist chain and cascades the entries away,
which is exactly what removing it should do and is not something restoring
a snapshot does better. **To undo an edit to an existing playlist, replay
the `undo` the edit returned instead** — it names the precise
`add_tracks_to_playlist`, `remove_tracks_from_playlist` or
`reorder_playlist` call that puts the playlist back exactly as it was,
without touching anything else Engine DJ has recorded since.

`run_sql` accepts arbitrary SQL, but only the first statement is ever
executed, and `VACUUM`, `ATTACH` and `DETACH` are rejected outright, so a
chained or exfiltrating statement cannot slip past the read-only connection.

If Engine DJ was closed uncleanly and left an unrecovered journal, this
server will not open the library to "fix" it, with or without
`--allow-writes` — rolling a journal forward is a repair on someone else's
file, and every write tool refuses such a library outright rather than
letting SQLite do it on the way in. It reports `library_needs_recovery` and
asks you to launch Engine DJ once so it can recover its own library.

## Limitations

Read this before deciding what to trust.

**The `PerformanceData` layouts are reverse-engineered**, so every decoded
field says which kind it is. All four are marked `layout: "verified"` —
derived from and checked against a real Engine DJ 3.0.x library of 281
analysed tracks, where cue offsets land inside the track, the beatgrid's
implied tempo matches `bpmAnalyzed` on all 281, and the waveform's declared
point spacing multiplies back out to the track's sample count on all 281.

Loops were the last to earn it. The slot grid was pinned down by 2248
sentinels, but no library available had a loop saved in it, so a *populated*
slot stayed untested and loops carried `layout: "unverified"` through several
releases. One deliberately saved loop settled it: its slot spans 1.678321678 s
on a track Engine analysed at 143 BPM, which is four beats to within 4e-15 s.
Only the right field order, unit and endianness land on a whole beat count.

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

**It writes nothing but playlists, and only when you ask for it.** Without
`--allow-writes` the library is opened read-only at the OS level and there is
no tool that could write. With the flag, the four write tools add, edit and
reorder playlists — and that is the whole list. Not a cue, not a tag, not a
rating, and not even the recovery of a journal Engine DJ left behind.

**It does not read play history.** `Track.timeLastPlayed` answers "what have I
not played in six months?", but the separate Engine history database —
sessions, decks, what followed what — is not opened at all.

**Smartlists are not reported.** Engine's rule-based lists live in a separate
`Smartlist` table with its own ordering and a JSON rule column, and nothing
here reads it. `get_playlists` reports ordinary playlists and folders only, so
a smartlist you can see in Engine will not appear.

**An empty folder reads as an empty playlist.** Engine's schema has no folder
flag — a folder is simply a playlist that other playlists sit under — so
`is_folder` means "has child lists". A folder you have emptied is
indistinguishable from a playlist with no tracks.

**A playlist's tracks can be edited; the playlist itself cannot.** With
`--allow-writes` a new playlist can be created, and an existing one can have
tracks added, removed or reordered — but not renamed, deleted, moved between
folders, or turned into a folder itself, and there are no set lists or
suggested transitions. It answers questions about the collection and writes
down the answer if you ask; the mixing is yours.

**Schema 3.0.0 through 3.0.2 only.** Older and newer libraries are listed with
their version and reported as unsupported rather than read on a guess.

## Licence

MIT — see [LICENSE](./LICENSE).
