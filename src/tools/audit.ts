// src/tools/audit.ts
import { existsSync } from "node:fs";
import { z } from "zod";
import { err, isEngineError, type EngineError } from "../errors.js";
import { absTrackPath } from "../paths.js";
import type { QueryProcess } from "../proc/query-client.js";

export const AUDIT_CHECKS = [
  "missing_files",
  "unavailable",
  "unanalyzed",
  "no_cues",
  "no_beatgrid",
  "missing_key",
  "suspicious_bpm",
  "duplicates",
  "empty_metadata",
  "orphan_entries",
] as const;

export const AuditInput = z.object({ checks: z.array(z.string()).optional() });
export type AuditInput = z.input<typeof AuditInput>;

/**
 * Counts plus a small sample, never rows: this result lands in an LLM's
 * context. A library with thousands of unanalysed tracks would blow the
 * context window if every offending id came back, and the model only needs
 * to know there are thousands and see a handful — detail is fetched
 * separately (get_tracks) once someone wants it.
 */
const SAMPLE = 10;

/**
 * Pure-SQL checks, stored as the id expression plus the FROM/WHERE body so
 * the count and the sample can be built from one definition.
 *
 * They are issued as `SELECT COUNT(*) <body>` and `SELECT <id> <body> LIMIT
 * 10`, never as "fetch every offending row and take .length" -- that shipped
 * the entire result set over IPC into the MCP process just to measure it,
 * which contradicts the spec's "aggregates on the server" and made this the
 * one tool whose cost grew with the size of the library. SQLite computes both
 * numbers without materialising the rows anywhere else.
 *
 * missing_files is handled separately below: it is the one check that has to
 * touch the disk, so it genuinely needs every path.
 */
interface SqlCheck {
  /** The id expression to sample, also used to order the sample stably. */
  id: string;
  /** FROM ... [WHERE ...]; shared verbatim by the count and the sample. */
  body: string;
}

const SQL_CHECKS: Record<string, SqlCheck> = {
  unavailable: { id: "t.id", body: `FROM Track t WHERE t.isAvailable = 0` },
  unanalyzed: {
    id: "t.id",
    body: `FROM Track t WHERE t.isAnalyzed = 0 OR t.isAnalyzed IS NULL`,
  },
  // "Empty OR NULL", per the spec: a zero-length blob is not a cue list.
  // The same expression backs side.track_derived.has_cues/has_grid (see
  // sidecar/build.ts) and blobs/index.ts's `empty` status, so search, audit
  // and get_track_performance cannot disagree about the same track.
  no_cues: {
    id: "t.id",
    body: `FROM Track t LEFT JOIN PerformanceData p ON p.trackId = t.id
           WHERE COALESCE(length(p.quickCues), 0) = 0`,
  },
  no_beatgrid: {
    id: "t.id",
    body: `FROM Track t LEFT JOIN PerformanceData p ON p.trackId = t.id
           WHERE COALESCE(length(p.beatData), 0) = 0`,
  },
  missing_key: { id: "t.id", body: `FROM Track t WHERE t.key = -1 OR t.key IS NULL` },
  // bpm is stored at face value (not times 100, as rekordbox does).
  suspicious_bpm: {
    id: "t.id",
    body: `FROM Track t
           WHERE (t.bpmAnalyzed IS NOT NULL AND t.bpm IS NOT NULL
                  AND ABS(t.bpmAnalyzed - t.bpm) > 1.0)
              OR COALESCE(t.bpmAnalyzed, t.bpm) NOT BETWEEN 60 AND 200`,
  },
  empty_metadata: {
    id: "t.id",
    body: `FROM Track t
           WHERE t.title IS NULL OR TRIM(t.title) = ''
              OR t.artist IS NULL OR TRIM(t.artist) = ''`,
  },
  duplicates: {
    id: "t.id",
    body: `FROM Track t WHERE LOWER(TRIM(t.artist)) || '|' || LOWER(TRIM(t.title)) IN (
             SELECT LOWER(TRIM(artist)) || '|' || LOWER(TRIM(title)) FROM Track
             WHERE artist IS NOT NULL AND title IS NOT NULL
             GROUP BY 1 HAVING COUNT(*) > 1)`,
  },
  orphan_entries: {
    id: "e.id",
    body: `FROM PlaylistEntity e LEFT JOIN Track t ON t.id = e.trackId WHERE t.id IS NULL`,
  },
};

export async function auditLibrary(
  qp: QueryProcess,
  mdbPath: string,
  raw: AuditInput,
): Promise<{ checks: { name: string; count: number; sample_ids: number[] }[] } | EngineError> {
  const parsed = AuditInput.safeParse(raw);
  if (!parsed.success) {
    return err("invalid_argument", "checks must be an array of check names");
  }

  // Distinguish "omitted" from "explicitly empty" before defaulting:
  // omitting checks already means "run everything", so an empty array
  // carries no coherent second meaning, and returning { checks: [] } would
  // read to a model exactly like a clean bill of health on a library nobody
  // examined.
  if (parsed.data.checks && parsed.data.checks.length === 0) {
    return err("invalid_argument", "checks cannot be an empty array", {
      detail: "An empty list has no meaningful result; omit checks entirely to run every check.",
    });
  }

  const requested = parsed.data.checks ?? [...AUDIT_CHECKS];
  // A check name is not a value that flows into SQL — it only ever selects
  // which fixed query text runs — but an unrecognised one must still be
  // rejected outright rather than silently ignored, naming what was wrong.
  const unknown = requested.filter((c) => !(AUDIT_CHECKS as readonly string[]).includes(c));
  if (unknown.length) {
    return err("invalid_argument", `Unknown audit checks: ${unknown.join(", ")}`, {
      detail: `Known checks: ${AUDIT_CHECKS.join(", ")}`,
    });
  }

  const out: { name: string; count: number; sample_ids: number[] }[] = [];
  for (const name of requested) {
    if (name === "missing_files") {
      const res = await qp.run(`SELECT id, path FROM Track WHERE path IS NOT NULL`);
      if (isEngineError(res)) return res;
      const missing: number[] = [];
      for (const row of res.rows) {
        if (!existsSync(absTrackPath(mdbPath, String(row[1])))) missing.push(Number(row[0]));
      }
      out.push({ name, count: missing.length, sample_ids: missing.slice(0, SAMPLE) });
      continue;
    }
    const check = SQL_CHECKS[name]!;
    const counted = await qp.run(`SELECT COUNT(*) AS c ${check.body}`);
    if (isEngineError(counted)) return counted;
    // ORDER BY the id keeps the sample stable between calls; every id
    // expression here is a primary key, so this is not an extra sort.
    // SAMPLE is a module constant, never caller input, but bind it anyway
    // rather than making an exception to "every value is a parameter".
    const sampled = await qp.run(
      `SELECT ${check.id} AS id ${check.body} ORDER BY ${check.id} LIMIT ?`,
      [SAMPLE],
    );
    if (isEngineError(sampled)) return sampled;
    out.push({
      name,
      count: Number(counted.rows[0]?.[0] ?? 0),
      sample_ids: sampled.rows.map((r) => Number(r[0])),
    });
  }
  return { checks: out };
}
