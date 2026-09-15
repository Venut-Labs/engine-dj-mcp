// src/store/track-metadata-plan.ts
//
// The pure half of update_track_metadata (spec docs/superpowers/specs/
// 2026-09-14-track-metadata-design.md). No database access, so every rule can
// be tested against an exact row.
import { err, type EngineError } from "../errors.js";
import { NOT_COMMITTED } from "./write.js";

export type FieldName = "genre" | "comment" | "label" | "year" | "rating";
export const TEXT_FIELDS = ["genre", "comment", "label"] as const;
export type TextField = (typeof TEXT_FIELDS)[number];

export interface TrackExpect {
  genre?: string;
  comment?: string;
  label?: string;
  year?: number;
  rating_raw?: number;
}

export interface TrackUpdate {
  id: number;
  genre?: string;
  comment?: string;
  label?: string;
  year?: number;
  rating_stars?: number;
  rating_raw?: number;
  expect?: TrackExpect;
}

export const MAX_UPDATES = 200;
export const MAX_TEXT = 1000;
const LIST_LIMIT = 20;

/** The columns an update writes, in a fixed order. Both rating inputs write `rating`. */
export function writtenFields(u: TrackUpdate): FieldName[] {
  const out: FieldName[] = [];
  for (const f of TEXT_FIELDS) if (u[f] !== undefined) out.push(f);
  if (u.year !== undefined) out.push("year");
  if (u.rating_stars !== undefined || u.rating_raw !== undefined) out.push("rating");
  return out;
}

/**
 * A refusal names every offender, not the first (spec §7.3): one vanished
 * track must not cost two hundred round trips. Capped so the message stays
 * readable.
 */
export function listProblems(problems: string[]): string {
  const shown = problems.slice(0, LIST_LIMIT).join("; ");
  const rest = problems.length - LIST_LIMIT;
  return rest > 0 ? `${shown}; and ${rest} more` : shown;
}

const isWhole = (n: number, lo: number, hi: number) => Number.isInteger(n) && n >= lo && n <= hi;

/**
 * Rules that need no database. Ranges check NEW values only: a field written
 * together with `expect` on the same field is a restore -- typically a replayed
 * undo -- and must be able to put back whatever was there, however odd
 * (spec §5.3). rating_raw is the exception that proves the rule: it exists only
 * for restoring, so it always needs expect.rating_raw, and its 0-255 bound (the
 * ID3 scale) always applies.
 */
export function validateUpdates(updates: TrackUpdate[]): EngineError | undefined {
  if (updates.length === 0) {
    return err("invalid_argument", "updates is empty; name at least one track to change. Nothing was written.", {
      detail: NOT_COMMITTED,
    });
  }

  const problems: string[] = [];
  if (updates.length > MAX_UPDATES) problems.push(`${updates.length} updates, more than the ${MAX_UPDATES} allowed per call`);

  const seen = new Set<number>();
  const repeated = new Set<number>();
  for (const u of updates) {
    if (seen.has(u.id)) repeated.add(u.id);
    seen.add(u.id);
  }
  if (repeated.size > 0) {
    problems.push(`track id${repeated.size > 1 ? "s" : ""} ${[...repeated].join(", ")} named more than once`);
  }

  for (const u of updates) {
    const at = `track ${u.id}`;
    const fields = writtenFields(u);
    const expect = u.expect ?? {};

    if (fields.length === 0) problems.push(`${at}: no field to change`);
    if (u.rating_stars !== undefined && u.rating_raw !== undefined) {
      problems.push(`${at}: rating_stars and rating_raw together`);
    }
    if (u.rating_raw !== undefined && expect.rating_raw === undefined) {
      problems.push(`${at}: rating_raw restores an exact value and needs expect.rating_raw; to set a rating use rating_stars`);
    }
    for (const key of Object.keys(expect) as (keyof TrackExpect)[]) {
      if (expect[key] === undefined) continue;
      const writes = key === "rating_raw" ? fields.includes("rating") : fields.includes(key);
      if (!writes) problems.push(`${at}: expect.${key} names a field this update does not change`);
    }

    if (u.rating_stars !== undefined && !isWhole(u.rating_stars, 0, 5)) {
      problems.push(`${at}: rating_stars must be a whole number 0-5`);
    }
    if (u.rating_raw !== undefined && !isWhole(u.rating_raw, 0, 255)) {
      problems.push(`${at}: rating_raw must be a whole number 0-255`);
    }
    if (u.year !== undefined) {
      if (!Number.isInteger(u.year)) problems.push(`${at}: year must be a whole number`);
      else if (expect.year === undefined && u.year !== 0 && !isWhole(u.year, 1000, 2200)) {
        problems.push(`${at}: year must be 0 (unknown) or 1000-2200`);
      }
    }
    for (const f of TEXT_FIELDS) {
      const v = u[f];
      if (v !== undefined && expect[f] === undefined && v.length > MAX_TEXT) {
        problems.push(`${at}: ${f} is longer than ${MAX_TEXT} characters`);
      }
    }
  }

  if (problems.length === 0) return undefined;
  return err(
    "invalid_argument",
    `${problems.length} problem${problems.length > 1 ? "s" : ""} with updates, nothing was written: ${listProblems(problems)}`,
    { detail: NOT_COMMITTED },
  );
}
