// src/playlists.ts
import { err, isEngineError, type EngineError } from "./errors.js";
import type { QueryProcess } from "./proc/query-client.js";

/**
 * Engine stores both playlist order and playlist-entry order as singly
 * linked lists, not as a position column:
 *
 *   Playlist.nextListId       — the next sibling under the same parentListId
 *   PlaylistEntity.nextEntityId — the next entry in the same listId
 *
 * Both terminate at 0.
 *
 * The schema also ships a `PlaylistPath` view carrying a column literally
 * called `position`, which is the obvious thing to reach for and is wrong.
 * Its `OrderedList` CTE anchors on `WHERE nextListId = 0` and counts
 * *upwards from the tail*, then orders by that count ascending — so its
 * `position` runs backwards. Measured on the reference library (16
 * playlists): walking the chain yields
 *   ACID Beach, KatyaBar, Electro 1, Old Fasion 1A 120-130, Playlist, ...
 * which is what Engine DJ shows in its sidebar, while the view's position
 * order is that list exactly reversed (asserted in tests/playlists.test.ts
 * against the same shape). The chain is the source of truth; the view is
 * never read by this project.
 *
 * Everything here therefore walks the chain — defensively. These are linked
 * lists inside a file this server does not own and never writes: a
 * half-completed Engine write, a sync conflict or a partially restored
 * backup can leave a cycle, a link to a row that is gone, or two
 * disconnected runs. None of those may hang the walk, and none may come
 * back as a silently short list that reads like a complete one.
 */

/**
 * The predicate that connects one `PlaylistEntity` (`e`) to its `Track` (`t`).
 *
 * A playlist entry does not name a local row id. It carries
 * `(databaseUuid, trackId)`, which identifies the track **in the library the
 * entry was made in**, and `Track` preserves that same identity in
 * `(originDatabaseUuid, originTrackId)` — a pair that need not equal, and
 * usually does not equal, `Track.id`. Engine's own schema says as much: the
 * pair carries `CONSTRAINT C_originDatabaseUuid_originTrackId UNIQUE`, making
 * it the track's natural key across drives, and a pair of triggers
 * (`trigger_after_insert_Track_fix_origin` and its update twin) stamps it
 * from `Information.uuid` whenever a row arrives without one. Engine's
 * application binary embeds the same join verbatim:
 *
 *   SELECT COUNT(DISTINCT databaseUuid || trackId) FROM PlaylistEntity
 *   JOIN Track ON (originDatabaseUuid, originTrackId) = (databaseUuid, trackId)
 *
 * Joining on `e.trackId = t.id` instead reads naturally and is wrong in both
 * directions. Measured on the reference USB library (257 tracks, 16
 * playlists, 202 entries): the id join reports 105 of 202 entries as orphans
 * where the pair join finds 0, because 178 entries name a *third* library
 * (`33be3313-…`) that is neither of the two attached and only 91 of the 257
 * tracks carry this database's own uuid — a healthy library reported as
 * riddled with holes, and one 43-entry playlist reduced to a single playable
 * track. In the other direction it silently answers with the *wrong track*
 * whenever a foreign entry's `trackId` happens to collide with a local row
 * id, and calls a genuinely missing entry present.
 *
 * Written once and shared, so the three places that ask the question cannot
 * drift apart. It names the aliases `t` and `e`; every call site uses them.
 */
export const ENTRY_TRACK_MATCH =
  "t.originDatabaseUuid = e.databaseUuid AND t.originTrackId = e.trackId";

/** One node of an Engine linked list. `next` is 0 at the end of the chain. */
export interface Linked {
  id: number;
  next: number;
}

export interface ChainOrder<T> {
  order: T[];
  warnings: string[];
}

/**
 * Orders one linked-list group, and says so when it could not.
 *
 * The contract that matters: `order` always contains **every** input node,
 * exactly once. A chain defect degrades the *order* and raises a warning; it
 * never drops a node, because a caller cannot tell a truncated list from a
 * short one, and `get_playlist_tracks` returning 30 of 43 entries with no
 * complaint is a worse answer than returning 43 in a partly-guessed order
 * with an explanation attached.
 *
 * Walk termination does not rely on a magic iteration cap: every step either
 * marks one previously unseen node visited or stops, so the walk is bounded
 * by the group size by construction. Anything the walk could not reach is
 * appended in id order.
 *
 * `subject` prefixes the warnings, so a caller reading a whole tree can tell
 * which playlist was malformed.
 */
export function orderByChain<T extends Linked>(nodes: readonly T[], subject: string): ChainOrder<T> {
  const warnings: string[] = [];
  if (nodes.length <= 1) return { order: [...nodes], warnings };

  const byId = new Map<number, T>();
  for (const n of nodes) byId.set(n.id, n);

  // A head is a node nothing else in this group points at. A self-link
  // (next === id) is not a reference to a *different* node, so it must not
  // hide its own node from the head search -- otherwise a single self-linked
  // row leaves the group headless and falls back to id order for no reason.
  const referenced = new Set<number>();
  for (const n of nodes) {
    if (n.next !== n.id && byId.has(n.next)) referenced.add(n.next);
  }
  const selfLinked = nodes.filter((n) => n.next === n.id);
  if (selfLinked.length) {
    warnings.push(
      `${subject}: ${selfLinked.length === 1 ? "entry" : "entries"} ` +
        `${selfLinked.map((n) => `#${n.id}`).join(", ")} link to themselves; ` +
        `the chain is treated as ending there`,
    );
  }

  const heads = nodes.filter((n) => !referenced.has(n.id)).sort((a, b) => a.id - b.id);
  if (heads.length === 0) {
    warnings.push(
      `${subject}: the link chain has no start -- every element is pointed at by another, ` +
        `so it is a closed loop. All ${nodes.length} are listed in id order instead.`,
    );
  } else if (heads.length > 1) {
    warnings.push(
      `${subject}: the link chain is broken into ${heads.length} disconnected runs; ` +
        `they are listed one after another, each run starting from its lowest-numbered element.`,
    );
  }

  const order: T[] = [];
  const visited = new Set<number>();
  for (const head of heads) {
    let cur: T | undefined = head;
    while (cur) {
      if (visited.has(cur.id)) {
        // Reachable two ways: a genuine cycle, or two runs converging on a
        // shared tail. Either way the remainder of this run is already
        // placed, so stop rather than re-emitting it.
        warnings.push(
          `${subject}: following the chain reached #${cur.id} a second time; ` +
            `ordering of that run stopped there`,
        );
        break;
      }
      visited.add(cur.id);
      order.push(cur);
      if (cur.next === 0 || cur.next === cur.id) break;
      const next: T | undefined = byId.get(cur.next);
      if (!next) {
        warnings.push(
          `${subject}: #${cur.id} links to #${cur.next}, which is not in this list; ` +
            `ordering of that run stopped there`,
        );
        break;
      }
      cur = next;
    }
  }

  const leftover = nodes.filter((n) => !visited.has(n.id)).sort((a, b) => a.id - b.id);
  if (leftover.length) {
    if (heads.length > 0) {
      warnings.push(
        `${subject}: ${leftover.length} of ${nodes.length} could not be reached by following ` +
          `the chain; they are listed after it, in id order`,
      );
    }
    order.push(...leftover);
  }

  return { order, warnings };
}

/** A `Playlist` row, as this module needs it. */
export interface PlaylistRow extends Linked {
  title: string;
  parent: number;
  isPersisted: boolean;
  entryCount: number;
  missingCount: number;
}

/**
 * One playlist as reported to a caller.
 *
 * `is_folder` is derived, not stored: the schema has no folder flag, and
 * Engine's own folders are simply `Playlist` rows that other `Playlist` rows
 * name as their `parentListId`. So this means "has at least one child list",
 * which is exactly what Engine draws as a folder -- with one honest
 * consequence: a folder a DJ has emptied is indistinguishable from a
 * playlist with no tracks, and is reported as the latter.
 *
 * `track_count` is entries in this list itself, never a total rolled up from
 * children, so it matches the number Engine shows beside the playlist.
 * `missing_count` is how many of those entries name a track that is not in
 * this library -- see `get_playlist_tracks` for why that is routine rather
 * than a corruption.
 */
export interface PlaylistItem {
  id: number;
  name: string;
  /** Full path from the top of the tree, `/`-separated. Unique across the tree. */
  path: string;
  parent_id: number | null;
  depth: number;
  is_folder: boolean;
  is_persisted: boolean;
  track_count: number;
  missing_count: number;
}

/**
 * Recursion bound for the folder tree. A parent cycle cannot get past the
 * `placed` set below, so this only guards a legitimately -- absurdly -- deep
 * tree from exhausting the JS stack.
 */
const MAX_DEPTH = 64;

/** Playlists read in one call. Beyond this the tree is reported truncated. */
const MAX_PLAYLISTS = 2000;

/** Entries ordered in one call, per playlist. */
const MAX_ENTRIES = 50_000;

/**
 * Flattens the playlist forest into Engine's own display order: each sibling
 * group in `nextListId` chain order, each list immediately followed by its
 * own children (pre-order), which is exactly what an expanded Engine sidebar
 * shows top to bottom.
 *
 * Flat-plus-`depth`-plus-`path` rather than nested `children` arrays: the
 * order Engine displays is then readable in a single pass down the array
 * without reconstructing a traversal, the result truncates to a genuine
 * prefix of the sidebar, and `path` gives every list a unique handle that a
 * bare name does not (see `findPlaylistByName`).
 */
export function buildPlaylistTree(rows: readonly PlaylistRow[]): {
  items: PlaylistItem[];
  warnings: string[];
} {
  const warnings: string[] = [];
  const byId = new Map<number, PlaylistRow>();
  for (const r of rows) byId.set(r.id, r);

  // Grouped by parent. A row whose parentListId names no existing playlist
  // is a real possibility (the parent folder was deleted without its
  // children, or only part of a library was restored) and is surfaced at the
  // top level rather than dropped -- an invisible playlist is the one
  // outcome worth avoiding here.
  const ROOT = 0;
  const children = new Map<number, PlaylistRow[]>();
  for (const r of rows) {
    let parent = r.parent;
    if (parent === r.id) {
      warnings.push(`Playlist #${r.id} "${r.title}" is its own parent; it is listed at the top level`);
      parent = ROOT;
    } else if (parent !== ROOT && !byId.has(parent)) {
      warnings.push(
        `Playlist #${r.id} "${r.title}" names parent #${parent}, which does not exist; ` +
          `it is listed at the top level`,
      );
      parent = ROOT;
    }
    const group = children.get(parent);
    if (group) group.push(r);
    else children.set(parent, [r]);
  }

  const items: PlaylistItem[] = [];
  const placed = new Set<number>();

  const walk = (parentId: number, depth: number, prefix: string): void => {
    const group = children.get(parentId);
    if (!group) return;
    const subject = parentId === ROOT ? "Top-level playlists" : `Playlist #${parentId}`;
    const { order, warnings: chainWarnings } = orderByChain(group, subject);
    warnings.push(...chainWarnings);
    for (const row of order) {
      if (placed.has(row.id)) continue;
      placed.add(row.id);
      const path = prefix ? `${prefix}/${row.title}` : row.title;
      const kids = children.get(row.id);
      items.push({
        id: row.id,
        name: row.title,
        path,
        parent_id: parentId === ROOT ? null : parentId,
        depth,
        is_folder: Boolean(kids && kids.length),
        is_persisted: row.isPersisted,
        track_count: row.entryCount,
        missing_count: row.missingCount,
      });
      if (!kids || !kids.length) continue;
      if (depth + 1 >= MAX_DEPTH) {
        warnings.push(
          `Playlist #${row.id} "${row.title}" nests deeper than ${MAX_DEPTH} levels; ` +
            `its children are listed at the top level instead`,
        );
        continue;
      }
      walk(row.id, depth + 1, path);
    }
  };

  walk(ROOT, 0, "");

  // Anything still unplaced sits in a parent cycle (A's parent is B, B's
  // parent is A), so no root traversal can reach it. Surface it flat.
  const unreachable = rows.filter((r) => !placed.has(r.id)).sort((a, b) => a.id - b.id);
  if (unreachable.length) {
    warnings.push(
      `${unreachable.length} playlist(s) are inside a parentListId loop and belong to no top-level ` +
        `branch; they are listed at the end, in id order`,
    );
    for (const row of unreachable) {
      placed.add(row.id);
      items.push({
        id: row.id,
        name: row.title,
        path: row.title,
        parent_id: row.parent === 0 ? null : row.parent,
        depth: 0,
        is_folder: Boolean(children.get(row.id)?.length),
        is_persisted: row.isPersisted,
        track_count: row.entryCount,
        missing_count: row.missingCount,
      });
    }
  }

  return { items, warnings };
}

export interface PlaylistTree {
  items: PlaylistItem[];
  warnings: string[];
  /** Playlists in the library, even when more were found than were returned. */
  total: number;
  truncated: boolean;
}

/**
 * Reads every playlist plus its entry counts, and orders the result.
 *
 * The counts come from one grouped pass over `PlaylistEntity` rather than a
 * correlated subquery per playlist, and `missing_count` is computed in the
 * same pass: "how many of these can I actually play" is not a rare question
 * and must not cost a second round trip per list.
 *
 * `missing` is an EXISTS semi-join on the natural key (see
 * ENTRY_TRACK_MATCH), not a LEFT JOIN to Track. Membership is the whole
 * question, and a semi-join cannot inflate `n`: a joined row set would count
 * one entry twice if two tracks ever answered to the same origin key, which
 * Engine's UNIQUE constraint forbids but this server has no way to enforce
 * on a file it does not own.
 */
export async function loadPlaylistTree(qp: QueryProcess): Promise<PlaylistTree | EngineError> {
  const res = await qp.run(
    `SELECT p.id, p.title, p.parentListId, p.isPersisted, p.nextListId,
            COALESCE(c.n, 0) AS entry_count, COALESCE(c.missing, 0) AS missing_count
       FROM main.Playlist p
       LEFT JOIN (SELECT e.listId AS listId, COUNT(*) AS n,
                         SUM(CASE WHEN EXISTS (SELECT 1 FROM main.Track t
                                                WHERE ${ENTRY_TRACK_MATCH})
                                  THEN 0 ELSE 1 END) AS missing
                    FROM main.PlaylistEntity e
                   GROUP BY e.listId) c ON c.listId = p.id
      ORDER BY p.id
      LIMIT ?`,
    // One over the cap, so "there are more" is observed rather than inferred
    // from a full page.
    [MAX_PLAYLISTS + 1],
  );
  if (isEngineError(res)) return res;

  const idx = Object.fromEntries(res.columns.map((c, i) => [c, i]));
  const truncated = res.rows.length > MAX_PLAYLISTS;
  const kept = truncated ? res.rows.slice(0, MAX_PLAYLISTS) : res.rows;
  const rows: PlaylistRow[] = kept.map((r) => ({
    id: Number(r[idx.id!]),
    // Engine's column is nullable; a nameless playlist must still be
    // listed (and addressable by id) rather than crash the projection.
    title: r[idx.title!] === null || r[idx.title!] === undefined ? "" : String(r[idx.title!]),
    parent: Number(r[idx.parentListId!] ?? 0),
    isPersisted: Boolean(Number(r[idx.isPersisted!] ?? 0)),
    next: Number(r[idx.nextListId!] ?? 0),
    entryCount: Number(r[idx.entry_count!] ?? 0),
    missingCount: Number(r[idx.missing_count!] ?? 0),
  }));

  const { items, warnings } = buildPlaylistTree(rows);
  if (truncated) {
    warnings.unshift(
      `This library holds more than ${MAX_PLAYLISTS} playlists; only the first ${MAX_PLAYLISTS} ` +
        `by id were read, so the reported order and nesting are incomplete`,
    );
  }
  return { items, warnings, total: rows.length, truncated };
}

/**
 * Every list matching a caller-supplied name, most specific interpretation
 * first.
 *
 * `Playlist` is unique on `(title, parentListId)` only, so a bare name is
 * genuinely ambiguous the moment a DJ uses folders -- "House" under
 * *Warmup* and "House" under *Peak* are two different playlists and neither
 * is the obvious winner. A full path is unique by construction, so it is
 * tried first and gives a caller a way to say precisely which one they mean;
 * a bare title is tried next and may legitimately return several, which the
 * caller turns into an error rather than an arbitrary pick.
 *
 * Case-insensitive matching is a fallback tier, not the primary rule: a
 * library containing both "Peak" and "peak" as siblings is legal, and an
 * exact match must win outright rather than being reported as ambiguous
 * against its own differently-cased neighbour.
 */
export function findPlaylistByName(items: readonly PlaylistItem[], name: string): PlaylistItem[] {
  const wanted = name.trim();
  if (!wanted) return [];
  const fold = (s: string) => s.trim().toLowerCase();
  const folded = fold(wanted);
  const tiers = [
    items.filter((i) => i.path === wanted),
    items.filter((i) => i.name === wanted),
    items.filter((i) => fold(i.path) === folded),
    items.filter((i) => fold(i.name) === folded),
  ];
  for (const tier of tiers) if (tier.length) return tier;
  return [];
}

/** How many playlists an error message lists before summarising the rest. */
const NAMED_IN_ERROR = 25;

function describe(items: readonly PlaylistItem[]): string {
  const shown = items.slice(0, NAMED_IN_ERROR).map((i) => `${i.id} -- ${i.path}`).join("; ");
  return items.length > NAMED_IN_ERROR
    ? `${shown}; and ${items.length - NAMED_IN_ERROR} more (call get_playlists to see them all)`
    : shown;
}

export interface PlaylistSelector {
  id?: number;
  name?: string;
}

/** The argument names to quote back in an error, so each tool blames its own. */
export interface SelectorNames {
  id: string;
  name: string;
}

export interface ResolvedPlaylist {
  playlist: PlaylistItem;
  /** Chain warnings raised while building the tree this playlist came from. */
  warnings: string[];
}

/**
 * Turns "id or name" into one specific playlist, or an actionable error.
 *
 * Ambiguity is never resolved by picking: two playlists really can share a
 * name, and quietly answering about the wrong one is the failure mode this
 * whole function exists to prevent. The error names every candidate with its
 * id and its full path, so the retry is a copy-paste rather than a guess.
 *
 * Deliberately reuses `invalid_argument` rather than adding an error code:
 * the taxonomy is closed (see errors.ts), and "the playlist you named is not
 * in this library" is a problem with the argument, reported the same way an
 * unknown field name is -- with the recognised values in `detail`.
 */
export async function resolvePlaylist(
  qp: QueryProcess,
  sel: PlaylistSelector,
  names: SelectorNames = { id: "playlist_id", name: "playlist_name" },
): Promise<ResolvedPlaylist | EngineError> {
  const hasId = sel.id !== undefined && sel.id !== null;
  const hasName = typeof sel.name === "string" && sel.name.trim() !== "";
  if (hasId && hasName) {
    return err("invalid_argument", `Pass ${names.id} or ${names.name}, not both`, {
      detail: "They can name different playlists, so there is no safe way to combine them.",
    });
  }
  if (!hasId && !hasName) {
    return err("invalid_argument", `Name the playlist: pass ${names.id} or ${names.name}`, {
      detail: "call get_playlists to see the ids and names in this library.",
    });
  }

  const tree = await loadPlaylistTree(qp);
  if (isEngineError(tree)) return tree;

  if (hasId) {
    const found = tree.items.find((i) => i.id === sel.id);
    if (!found) {
      return err("invalid_argument", `No playlist with ${names.id} ${sel.id} in this library`, {
        detail: tree.items.length
          ? `Playlists (id -- path): ${describe(tree.items)}`
          : "This library has no playlists.",
      });
    }
    return { playlist: found, warnings: tree.warnings };
  }

  const matches = findPlaylistByName(tree.items, sel.name!);
  if (matches.length === 1) return { playlist: matches[0]!, warnings: tree.warnings };
  if (matches.length === 0) {
    return err("invalid_argument", `No playlist named "${sel.name}" in this library`, {
      detail: tree.items.length
        ? `Playlists (id -- path): ${describe(tree.items)}`
        : "This library has no playlists.",
    });
  }
  return err("invalid_argument", `"${sel.name}" names ${matches.length} playlists in this library`, {
    detail:
      `Playlist names are unique only within a folder. Pass ${names.id}, or pass the full ` +
      `path as ${names.name}: ${describe(matches)}`,
  });
}

/** One entry of a playlist, in playlist order. */
export interface OrderedEntry extends Linked {
  /**
   * `PlaylistEntity.trackId` — the track's `originTrackId` in the library
   * `databaseUuid` names, **not** a local `Track.id`. The two halves only
   * mean anything together (see ENTRY_TRACK_MATCH), and together they need
   * not name a track this library holds.
   */
  trackId: number;
  /** The library this entry was made in. Null only in a malformed row. */
  databaseUuid: string | null;
  /** 1-based position within the playlist. */
  position: number;
}

export interface PlaylistEntries {
  entries: OrderedEntry[];
  warnings: string[];
}

/**
 * Every entry of one playlist, in `nextEntityId` chain order.
 *
 * The whole playlist is read before a page is cut from it, because position
 * *is* the ordering: there is no indexed column to seek on, so a page can
 * only be taken from an already-ordered list. That is affordable -- the
 * reference library's largest playlist is 43 entries and `PlaylistEntity` is
 * three integers wide -- and it is bounded by MAX_ENTRIES rather than by
 * hope.
 */
export async function loadPlaylistEntries(
  qp: QueryProcess,
  playlist: PlaylistItem,
): Promise<PlaylistEntries | EngineError> {
  const res = await qp.run(
    `SELECT e.id, e.trackId, e.databaseUuid, e.nextEntityId
       FROM main.PlaylistEntity e
      WHERE e.listId = ?
      ORDER BY e.id
      LIMIT ?`,
    [playlist.id, MAX_ENTRIES + 1],
  );
  if (isEngineError(res)) return res;

  const idx = Object.fromEntries(res.columns.map((c, i) => [c, i]));
  const truncated = res.rows.length > MAX_ENTRIES;
  const kept = truncated ? res.rows.slice(0, MAX_ENTRIES) : res.rows;
  const nodes = kept.map((r) => ({
    id: Number(r[idx.id!]),
    trackId: Number(r[idx.trackId!] ?? 0),
    databaseUuid: r[idx.databaseUuid!] === null || r[idx.databaseUuid!] === undefined
      ? null
      : String(r[idx.databaseUuid!]),
    next: Number(r[idx.nextEntityId!] ?? 0),
  }));

  const { order, warnings } = orderByChain(nodes, `Playlist "${playlist.name}"`);
  if (truncated) {
    warnings.unshift(
      `Playlist "${playlist.name}" holds more than ${MAX_ENTRIES} entries; only the first ` +
        `${MAX_ENTRIES} by id were read, so the reported order is incomplete`,
    );
  }
  return {
    entries: order.map((e, i) => ({ ...e, position: i + 1 })),
    warnings,
  };
}
