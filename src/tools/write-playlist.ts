// src/tools/write-playlist.ts
import { z } from "zod";
import { createPlaylist, type CreatePlaylistResult } from "../store/write.js";
import { type EngineError } from "../errors.js";

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
