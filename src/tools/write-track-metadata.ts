// src/tools/write-track-metadata.ts
import { z } from "zod";
import { updateTrackMetadata } from "../store/track-metadata.js";
import { MAX_UPDATES, type TrackUpdate } from "../store/track-metadata-plan.js";

/**
 * Types and the per-call cap only (spec §7.1). Every other rule -- ranges,
 * which depend on whether `expect` is present, and the rating_raw restore
 * rule -- lives in the store, so it comes back as a structured
 * invalid_argument instead of a bare SDK validation message. `.strict()` makes
 * a misnamed field such as `rating` an error rather than silently ignored.
 */
const Expect = z
  .object({
    genre: z.string().optional(),
    comment: z.string().optional(),
    label: z.string().optional(),
    year: z.number().int().optional(),
    rating_raw: z.number().int().optional(),
  })
  .strict();

export const UpdateTrackMetadataInput = z.object({
  updates: z
    .array(
      z
        .object({
          id: z.number().int().positive(),
          genre: z.string().optional(),
          comment: z.string().optional(),
          label: z.string().optional(),
          year: z.number().int().optional(),
          rating_stars: z.number().int().optional(),
          rating_raw: z.number().int().optional(),
          expect: Expect.optional(),
        })
        .strict(),
    )
    .max(MAX_UPDATES)
    .describe(
      "One entry per track: its id from search_tracks or get_tracks, and only the fields to change. " +
        '"" clears a text field. rating_stars is 0-5. rating_raw and expect exist for replaying an undo; ' +
        "you do not need them for an ordinary edit.",
    ),
});

export async function runUpdateTrackMetadata(
  mdbPath: string,
  uuid: string,
  args: { updates: TrackUpdate[] },
  backupDir: string,
) {
  return updateTrackMetadata(mdbPath, uuid, { updates: args.updates }, { backupDir });
}
