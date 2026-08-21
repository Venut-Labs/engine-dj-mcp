import type { DatabaseSync } from "node:sqlite";
import { absTrackPath, redactPath } from "./paths.js";

/**
 * Engine's own conversion, taken from the application binary:
 *   CASE key WHEN -1 THEN NULL ELSE (key + 15 - 2 * (key % 2)) % 24 END
 * The result is a wheel index: even `key` gives mode B, odd gives A, and the
 * wheel number is floor(index / 2) + 1. key=0 is assumed to be C major, which
 * makes it 8B — the standard Camelot anchor.
 */
export function camelotIndex(key: number | null): number | null {
  if (key === null || key === undefined || !Number.isFinite(key) || key < 0 || key > 23) return null;
  return (key + 15 - 2 * (key % 2)) % 24;
}

export function camelot(key: number | null): string | null {
  const v = camelotIndex(key);
  if (v === null) return null;
  return `${Math.floor(v / 2) + 1}${v % 2 === 1 ? "B" : "A"}`;
}

const NAMES_B = ["B", "F#", "Db", "Ab", "Eb", "Bb", "F", "C", "G", "D", "A", "E"];
const NAMES_A = ["Abm", "Ebm", "Bbm", "Fm", "Cm", "Gm", "Dm", "Am", "Em", "Bm", "F#m", "Dbm"];

export function keyName(key: number | null): string | null {
  const label = camelot(key);
  if (!label) return null;
  const { number, mode } = parseCamelot(label)!;
  return mode === "B" ? NAMES_B[number - 1]! : NAMES_A[number - 1]!;
}

/**
 * `bpm` is stored at face value (102 means 102 BPM), not times one hundred as
 * in rekordbox. That times-100 rule was carried into this project from
 * rekordbox documentation by mistake; measured against a real Engine DJ 5.0
 * library (schema 3.0.2, history database) every non-null `bpm` among 24
 * analysed tracks agrees with `bpmAnalyzed` to within 0.68 — e.g. id=6
 * bpm=128 bpmAnalyzed=128, id=7 bpm=129 bpmAnalyzed=129 — not 12800/12900.
 */
export function tempo(bpmAnalyzed: number | null, bpm: number | null): number | null {
  if (bpmAnalyzed !== null && bpmAnalyzed !== undefined && bpmAnalyzed > 0) return bpmAnalyzed;
  if (bpm !== null && bpm !== undefined && bpm > 0) return bpm;
  return null;
}

export function parseCamelot(label: string): { number: number; mode: "A" | "B" } | null {
  const m = /^([1-9]|1[0-2])([AB])$/.exec(label.trim().toUpperCase());
  if (!m) return null;
  return { number: Number(m[1]), mode: m[2] as "A" | "B" };
}

/** Same number in the other mode, plus one step either way in the same mode. */
export function camelotNeighbours(label: string): string[] {
  const p = parseCamelot(label);
  if (!p) return [];
  const wrap = (n: number) => ((n - 1 + 12) % 12) + 1;
  return [
    `${p.number}${p.mode}`,
    `${p.number}${p.mode === "A" ? "B" : "A"}`,
    `${wrap(p.number - 1)}${p.mode}`,
    `${wrap(p.number + 1)}${p.mode}`,
  ];
}

export function keyDistance(a: string, b: string): number | null {
  const pa = parseCamelot(a), pb = parseCamelot(b);
  if (!pa || !pb) return null;
  const raw = Math.abs(pa.number - pb.number);
  return Math.min(raw, 12 - raw);
}

/**
 * SQL-callable versions of all five functions the spec lists. These are an
 * escape hatch for run_sql; filtering by key or tempo in a WHERE clause
 * should use the indexed sidecar columns in side.track_derived, because a JS
 * callback runs per row and defeats indexes.
 *
 * `mdbPath` is what makes `abs_path` possible: Track.path is relative to the
 * `Engine Library` folder (and usually starts with `..`), so resolving it
 * needs to know where m.db lives. It is a parameter rather than a lookup so
 * a connection can never resolve paths against the wrong library.
 */
export function registerFunctions(db: DatabaseSync, mdbPath: string): void {
  const opts = { deterministic: true } as const;
  db.function("camelot", opts, (key: unknown) => camelot(key === null ? null : Number(key)));
  db.function("key_name", opts, (key: unknown) => keyName(key === null ? null : Number(key)));
  db.function("tempo", opts, (a: unknown, b: unknown) =>
    tempo(a === null ? null : Number(a), b === null ? null : Number(b)));
  db.function("key_distance", opts, (a: unknown, b: unknown) =>
    a === null || b === null ? null : keyDistance(String(a), String(b)));
  // Redacted, like every other absolute path this project hands back: the
  // result of this function goes to a model provider through run_sql, and
  // the home prefix carries the user's account name.
  db.function("abs_path", opts, (p: unknown) =>
    p === null || p === undefined ? null : redactPath(absTrackPath(mdbPath, String(p))));
}
