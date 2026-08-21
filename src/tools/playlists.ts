// src/tools/playlists.ts
import { z } from "zod";
import { err, isEngineError, type EngineError } from "../errors.js";
import { redactPath } from "../paths.js";
import {
  loadPlaylistEntries,
  loadPlaylistTree,
  resolvePlaylist,
  type PlaylistItem,
} from "../playlists.js";
import { DEFAULT_FIELDS, FIELD_SQL } from "./search.js";
import type { QueryProcess } from "../proc/query-client.js";

/**
 * Playlists returned in one call. Higher than any real library needs (the
 * reference library has 16) but the result still goes into a model's
 * context, so it is a cap rather than "everything".
 */
const MAX_PLAYLIST_PAGE = 1000;

/** Matches search_tracks: the largest page of tracks any tool will return. */
const MAX_TRACK_LIMIT = 200;

export const GetPlaylistsInput = z.object({
  limit: z.number().int().positive().default(200),
});
export type GetPlaylistsInput = z.input<typeof GetPlaylistsInput>;

export interface GetPlaylistsResult {
  playlists: PlaylistItem[];
  total: number;
  truncated: boolean;
  warnings?: string[];
}

/**
 * The library's playlist tree, in the order Engine DJ displays it.
 *
 * Flat, in pre-order, with `depth` and `path` carrying the nesting -- see
 * buildPlaylistTree for why that beats nested `children` arrays here.
 */
export async function getPlaylists(
  qp: QueryProcess,
  raw: GetPlaylistsInput,
): Promise<GetPlaylistsResult | EngineError> {
  const parsed = GetPlaylistsInput.safeParse(raw);
  if (!parsed.success) return err("invalid_argument", "limit must be a positive integer");
  const limit = Math.min(parsed.data.limit, MAX_PLAYLIST_PAGE);

  const tree = await loadPlaylistTree(qp);
  if (isEngineError(tree)) return tree;

  const playlists = tree.items.slice(0, limit);
  // Two independent reasons the answer can be short: more playlists exist
  // than this page holds, and more exist than loadPlaylistTree would read at
  // all. Both mean "this is not the whole tree", so both set the same flag.
  const truncated = tree.truncated || playlists.length < tree.items.length;
  return {
    playlists,
    total: tree.total,
    truncated,
    ...(tree.warnings.length ? { warnings: tree.warnings } : {}),
  };
}

export const GetPlaylistTracksInput = z.object({
  playlist_id: z.number().int().positive().optional(),
  playlist_name: z.string().min(1).optional(),
  fields: z.array(z.string()).optional(),
  limit: z.number().int().positive().default(25),
  cursor: z.string().optional(),
  redact_paths: z.boolean().default(true),
});
export type GetPlaylistTracksInput = z.input<typeof GetPlaylistTracksInput>;

/**
 * A row of a playlist. Either a track (the requested `fields`, plus its
 * position) or a hole where a track used to be.
 *
 * A hole is a real, ordinary state, not corruption: `PlaylistEntity` rows
 * survive their track and also arrive from other databases when a DJ merges
 * drives, which is why `audit_library` has an `orphan_entries` check at all.
 * On the reference USB library 105 of 202 entries are holes, and one
 * 43-entry playlist resolves to a single playable track.
 *
 * They are kept in the list rather than filtered out, at their real
 * positions, precisely so `tracks.length` still equals the playlist's own
 * length and position 12 is still the twelfth thing the DJ sees in Engine.
 * Dropping them would make a 43-entry playlist silently return 1 row and
 * look like a paging bug.
 */
export type PlaylistTrackRow = Record<string, unknown>;

export interface GetPlaylistTracksResult {
  playlist: PlaylistItem;
  tracks: PlaylistTrackRow[];
  /** Entries in the whole playlist, not in this page. */
  entry_count: number;
  /** Entries in the whole playlist whose track is not in this library. */
  missing_count: number;
  next_cursor?: string;
  warnings?: string[];
}

/**
 * A cursor here is just "resume at position N of playlist P".
 *
 * It carries the playlist id so a cursor from one playlist cannot page
 * through another: unlike search_tracks, whose cursor encodes a keyset that
 * could be silently misapplied to a different filter set, position N means
 * something in every playlist, so the wrong-playlist mistake would page
 * perfectly happily through the wrong list.
 */
function encodeCursor(playlistId: number, position: number): string {
  return Buffer.from(JSON.stringify([playlistId, position])).toString("base64url");
}

function decodeCursor(cursor: string): [number, number] | null {
  try {
    const v = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!Array.isArray(v) || v.length !== 2) return null;
    const [listId, position] = v;
    if (typeof listId !== "number" || typeof position !== "number") return null;
    if (!Number.isInteger(listId) || !Number.isInteger(position) || position < 1) return null;
    return [listId, position];
  } catch {
    return null;
  }
}

export async function getPlaylistTracks(
  qp: QueryProcess,
  raw: GetPlaylistTracksInput,
): Promise<GetPlaylistTracksResult | EngineError> {
  const parsed = GetPlaylistTracksInput.safeParse(raw);
  if (!parsed.success) {
    return err("invalid_argument", "Invalid arguments for get_playlist_tracks", {
      detail: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
    });
  }
  const input = parsed.data;

  // Same allowlist and same two failure messages as search_tracks and
  // get_tracks: a field name becomes SQL text, so it is checked against
  // FIELD_SQL rather than interpolated, and an empty list is a named error
  // instead of a raw SQLite syntax error.
  const requestedFields = input.fields ?? [...DEFAULT_FIELDS];
  if (requestedFields.length === 0) return err("invalid_argument", "No fields requested");
  const unknownFields = requestedFields.filter((f) => !(f in FIELD_SQL));
  if (unknownFields.length) {
    return err("invalid_argument", `Unknown field(s): ${unknownFields.join(", ")}`, {
      detail: `Recognised fields: ${Object.keys(FIELD_SQL).join(", ")}`,
    });
  }
  const fields = requestedFields;

  const resolved = await resolvePlaylist(qp, { id: input.playlist_id, name: input.playlist_name });
  if (isEngineError(resolved)) return resolved;
  const playlist = resolved.playlist;

  let from = 1;
  if (input.cursor) {
    const cur = decodeCursor(input.cursor);
    if (!cur) return err("invalid_argument", "Malformed cursor");
    if (cur[0] !== playlist.id) {
      return err(
        "invalid_argument",
        "This cursor belongs to a different playlist. Page with the playlist it came from, " +
          "or start again without a cursor.",
      );
    }
    from = cur[1];
  }

  const ordered = await loadPlaylistEntries(qp, playlist);
  if (isEngineError(ordered)) return ordered;

  const limit = Math.min(input.limit, MAX_TRACK_LIMIT);
  const page = ordered.entries.slice(from - 1, from - 1 + limit);

  // One lookup for the page, then reordered in memory -- SQL has no ordering
  // to offer here, since playlist order lives in a linked list and not in
  // any column that could appear in ORDER BY.
  const ids = [...new Set(page.map((e) => e.trackId).filter((id) => id > 0))];
  const byId = new Map<number, Record<string, unknown>>();
  if (ids.length) {
    const select = fields.map((f) => `${FIELD_SQL[f]} AS "${f}"`).join(", ");
    const res = await qp.run(
      `SELECT ${select}, t.id AS __id
         FROM main.Track t JOIN side.track_derived d ON d.track_id = t.id
        WHERE t.id IN (${ids.map(() => "?").join(",")})`,
      ids,
    );
    if (isEngineError(res)) return res;
    const idx = Object.fromEntries(res.columns.map((c, i) => [c, i]));
    for (const row of res.rows) {
      const track = Object.fromEntries(
        fields.map((f) => {
          const value = row[idx[f]!];
          return [
            f,
            input.redact_paths && f === "path" && typeof value === "string"
              ? redactPath(value)
              : value,
          ];
        }),
      );
      byId.set(Number(row[idx.__id!]), track);
    }
  }

  const tracks: PlaylistTrackRow[] = page.map((entry) => {
    const track = byId.get(entry.trackId);
    return track
      ? { position: entry.position, ...track }
      : {
          position: entry.position,
          entry_id: entry.id,
          track_id: entry.trackId,
          // Named, not implied by absent fields: a model must be able to tell
          // "this slot has no track in this library" from "this track has no
          // artist tag".
          missing: true,
        };
  });

  const last = page[page.length - 1];
  const next_cursor =
    last && last.position < ordered.entries.length
      ? encodeCursor(playlist.id, last.position + 1)
      : undefined;

  const warnings = [...resolved.warnings, ...ordered.warnings];
  return {
    playlist,
    tracks,
    entry_count: ordered.entries.length,
    missing_count: playlist.missing_count,
    ...(next_cursor ? { next_cursor } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
}
