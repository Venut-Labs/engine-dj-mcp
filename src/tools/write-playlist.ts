// src/tools/write-playlist.ts
import { z } from "zod";
import {
  createPlaylist,
  addTracksToPlaylist,
  removeTracksFromPlaylist,
  reorderPlaylist,
  type CreatePlaylistResult,
  type EditResult,
  type InsertAt,
} from "../store/write.js";
import { resolvePlaylist } from "../playlists.js";
import { type EngineError, isEngineError } from "../errors.js";
import type { QueryProcess } from "../proc/query-client.js";

export const CreatePlaylistInput = z.object({
  title: z.string().min(1).describe("Name for the new playlist. Must not already exist in this library."),
  track_ids: z
    .array(z.number().int().positive())
    .max(10_000)
    .describe(
      "Track ids from search_tracks, in the order they should appear in the playlist. May be empty.",
    ),
});

export async function runCreatePlaylist(
  mdbPath: string,
  uuid: string,
  args: { title: string; track_ids: number[] },
  backupDir: string,
): Promise<CreatePlaylistResult | EngineError> {
  return createPlaylist(mdbPath, uuid, { title: args.title, trackIds: args.track_ids }, { backupDir });
}

/** playlist_id/playlist_name, shared verbatim by every edit tool's schema below. */
const PlaylistSelectorShape = {
  playlist_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("The playlist's id, from get_playlists or get_playlist_tracks. Exactly one of playlist_id/playlist_name is required."),
  playlist_name: z
    .string()
    .min(1)
    .optional()
    .describe(
      "The playlist's name or full path (from get_playlists). Names are unique only within a " +
        "folder; a name matching more than one playlist is refused with every candidate listed, " +
        "not guessed at. Exactly one of playlist_id/playlist_name is required.",
    ),
};

const InsertAtInput = z.union([
  z.literal("start"),
  z.literal("end"),
  z.object({
    after_position: z
      .number()
      .int()
      .positive()
      .describe("1-based position, from get_playlist_tracks, to insert immediately after."),
  }),
]);

export const AddTracksToPlaylistInput = z.object({
  ...PlaylistSelectorShape,
  track_ids: z
    .array(z.number().int().positive())
    .max(10_000)
    .describe(
      "Track ids from search_tracks or get_tracks, in the order they should appear. A track " +
        "already in the playlist is refused as duplicate_track.",
    ),
  at: InsertAtInput.default("end").describe(
    "Where the new tracks land, against the playlist's current 1-based positions (the same " +
      "numbering get_playlist_tracks reports): \"start\", \"end\" (the default), or " +
      "{ after_position: n }.",
  ),
});

/**
 * Turns `playlist_id`/`playlist_name` into a concrete `listId`, the same way
 * `get_playlist_tracks` does (see resolvePlaylist in ../playlists.ts), so
 * every edit tool refuses an ambiguous name identically rather than each
 * growing its own resolution logic.
 */
async function resolveListId(
  qp: QueryProcess,
  args: { playlist_id?: number; playlist_name?: string },
): Promise<number | EngineError> {
  const resolved = await resolvePlaylist(qp, { id: args.playlist_id, name: args.playlist_name });
  if (isEngineError(resolved)) return resolved;
  return resolved.playlist.id;
}

export async function runAddTracksToPlaylist(
  qp: QueryProcess,
  mdbPath: string,
  uuid: string,
  args: { playlist_id?: number; playlist_name?: string; track_ids: number[]; at: InsertAt },
  backupDir: string,
): Promise<EditResult | EngineError> {
  const listId = await resolveListId(qp, args);
  if (isEngineError(listId)) return listId;
  return addTracksToPlaylist(mdbPath, uuid, { listId, trackIds: args.track_ids, at: args.at }, { backupDir });
}

export const RemoveTracksFromPlaylistInput = z.object({
  ...PlaylistSelectorShape,
  positions: z
    .array(z.number().int().positive())
    .max(50_000)
    .describe(
      "1-based positions to remove, from get_playlist_tracks against this playlist right now. " +
        "Includes entries whose track is missing from the library (missing: true).",
    ),
  expect_track_ids: z
    .array(z.number().int().positive().nullable())
    .optional()
    .describe(
      "Optional, one entry per position: verifies each named position still holds the track " +
        "expected before anything is removed. null means the position should hold an entry " +
        "whose track is missing from the library, not \"no expectation\".",
    ),
});

export async function runRemoveTracksFromPlaylist(
  qp: QueryProcess,
  mdbPath: string,
  uuid: string,
  args: {
    playlist_id?: number;
    playlist_name?: string;
    positions: number[];
    expect_track_ids?: (number | null)[];
  },
  backupDir: string,
): Promise<EditResult | EngineError> {
  const listId = await resolveListId(qp, args);
  if (isEngineError(listId)) return listId;
  return removeTracksFromPlaylist(
    mdbPath,
    uuid,
    { listId, positions: args.positions, expectTrackIds: args.expect_track_ids },
    { backupDir },
  );
}

export const ReorderPlaylistInput = z.object({
  ...PlaylistSelectorShape,
  order: z
    .array(z.number().int().positive())
    .max(50_000)
    .describe(
      "A full permutation of 1..n, n being the playlist's current entry count. order[i] names " +
        "the CURRENT 1-based position (from get_playlist_tracks) of the track that should end " +
        "up at position i + 1. Every position must be named, even ones that do not move.",
    ),
});

export async function runReorderPlaylist(
  qp: QueryProcess,
  mdbPath: string,
  uuid: string,
  args: { playlist_id?: number; playlist_name?: string; order: number[] },
  backupDir: string,
): Promise<EditResult | EngineError> {
  const listId = await resolveListId(qp, args);
  if (isEngineError(listId)) return listId;
  return reorderPlaylist(mdbPath, uuid, { listId, order: args.order }, { backupDir });
}
