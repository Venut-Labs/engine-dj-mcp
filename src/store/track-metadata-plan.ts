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

export type StoredValue = string | number | null;

/** One track as read from the library, already classified (see src/store/track-metadata.ts). */
export interface CurrentRow {
  id: number;
  genre: string | null;
  comment: string | null;
  label: string | null;
  year: number | null;
  rating: number | null;
  /** Columns whose stored value this tool could not put back (spec §5.3). */
  inexpressible: FieldName[];
  /** The fix-origin trigger's own WHEN, evaluated by SQLite (spec §3.3). */
  originEmpty: boolean;
}

export interface RowWrite {
  id: number;
  set: Partial<Record<FieldName, StoredValue>>;
  fields: FieldName[];
}

export interface Plan {
  writes: RowWrite[];
  unchanged: number[];
  undo: TrackUpdate[];
}

type Mismatch = NonNullable<EngineError["mismatches"]>[number];

/** The value a field will hold once written. `""` is NULL; stars are Engine's 0-100. */
export function targetOf(u: TrackUpdate, f: FieldName): StoredValue {
  if (f === "rating") return u.rating_raw !== undefined ? u.rating_raw : u.rating_stars! * 20;
  if (f === "year") return u.year!;
  const v = u[f]!;
  return v === "" ? null : v;
}

/**
 * Spec §5.1: NULL and '' are one empty for text, NULL and 0 for numbers.
 * Otherwise exact -- no Unicode folding, because hiding a real difference is
 * worse than reporting a confusing one (describeValue spells those out).
 * Done in JS: in SQL, NULL = '' is neither true nor false.
 */
export function sameStored(f: FieldName, a: StoredValue, b: StoredValue): boolean {
  if (f === "year" || f === "rating") return (a ?? 0) === (b ?? 0);
  return (a ?? "") === (b ?? "");
}

const codePoints = (s: string) =>
  [...s].map((c) => "U+" + c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")).join(" ");

function describeMismatch(m: Mismatch): string {
  const show = (v: StoredValue) => (v === null ? "empty" : JSON.stringify(v));
  let line = `track ${m.id} ${m.field}: expected ${show(m.expected)}, found ${show(m.actual)}`;
  if (
    typeof m.expected === "string" && typeof m.actual === "string" &&
    m.expected !== m.actual && m.expected.normalize("NFC") === m.actual.normalize("NFC")
  ) {
    line += ` (same text in a different Unicode form: expected ${codePoints(m.expected)}, found ${codePoints(m.actual)})`;
  }
  return line;
}

/**
 * Decide, for rows already read, what each update writes. Order matters and
 * follows spec §5.2 and §6: a row already at its target is unchanged before
 * anything else is asked of it -- expect included, since expect guards writes
 * and this row is not written. Refusals are collected across all rows and
 * reported by class: unknown ids first, then tracks that cannot be edited,
 * then stale expectations.
 */
export function planUpdates(updates: TrackUpdate[], rows: ReadonlyMap<number, CurrentRow>): Plan | EngineError {
  const plan: Plan = { writes: [], unchanged: [], undo: [] };
  const unknown: number[] = [];
  const notEditable: string[] = [];
  const mismatches: Mismatch[] = [];

  for (const u of updates) {
    const current = rows.get(u.id);
    if (!current) {
      unknown.push(u.id);
      continue;
    }

    // An inexpressible field is read as null, so comparing it would call a stored
    // 999 "already 0 stars". It always counts as different, which routes it to
    // the track_not_editable refusal below instead of a false "unchanged".
    const differs = writtenFields(u).filter(
      (f) => current.inexpressible.includes(f) || !sameStored(f, current[f], targetOf(u, f)),
    );
    if (differs.length === 0) {
      plan.unchanged.push(u.id);
      continue;
    }

    if (current.originEmpty) {
      notEditable.push(
        `track ${u.id}: its origin is empty, and Engine's own trigger rewrites an empty origin on any ` +
          `update, which would detach it from playlist entries on other drives; edit it in Engine DJ instead`,
      );
    }
    for (const f of differs) {
      if (current.inexpressible.includes(f)) {
        notEditable.push(`track ${u.id}: ${f} holds a stored value this tool could not put back`);
      }
    }

    const expect = u.expect ?? {};
    for (const key of Object.keys(expect) as (keyof TrackExpect)[]) {
      const expected = expect[key];
      if (expected === undefined) continue;
      const field: FieldName = key === "rating_raw" ? "rating" : key;
      const want: StoredValue = field === "year" || field === "rating" ? (expected as number) : (expected as string) || null;
      if (!sameStored(field, current[field], want)) {
        mismatches.push({ id: u.id, field: key, expected, actual: current[field] });
      }
    }

    const write: RowWrite = { id: u.id, set: {}, fields: differs };
    const back: TrackUpdate = { id: u.id, expect: {} };
    for (const f of differs) {
      const now = targetOf(u, f);
      write.set[f] = now;
      const was = current[f];
      if (f === "rating") {
        back.rating_raw = (was as number | null) ?? 0;
        back.expect!.rating_raw = (now as number | null) ?? 0;
      } else if (f === "year") {
        back.year = (was as number | null) ?? 0;
        back.expect!.year = (now as number | null) ?? 0;
      } else {
        back[f] = (was as string | null) ?? "";
        back.expect![f] = (now as string | null) ?? "";
      }
    }
    plan.writes.push(write);
    plan.undo.push(back);
  }

  if (unknown.length > 0) {
    return err(
      "unknown_track",
      `${unknown.length} track id${unknown.length > 1 ? "s are" : " is"} not in this library, nothing was written: ` +
        listProblems(unknown.map(String)),
      { detail: NOT_COMMITTED },
    );
  }
  if (notEditable.length > 0) {
    return err(
      "track_not_editable",
      `${notEditable.length} edit${notEditable.length > 1 ? "s" : ""} cannot be made, nothing was written: ${listProblems(notEditable)}`,
      { detail: NOT_COMMITTED },
    );
  }
  if (mismatches.length > 0) {
    return err(
      "stale_value",
      `${mismatches.length} expected value${mismatches.length > 1 ? "s" : ""} no longer match, nothing was written; ` +
        `re-read those tracks and retry: ${listProblems(mismatches.map(describeMismatch))}`,
      { detail: NOT_COMMITTED, mismatches: mismatches.slice(0, 20) },
    );
  }
  return plan;
}
