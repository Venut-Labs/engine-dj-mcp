// src/tools/search.ts
import { z } from "zod";
import { err, isEngineError, type EngineError } from "../errors.js";
import { camelotNeighbours } from "../semantics.js";
import type { QueryProcess } from "../proc/query-client.js";

export const DEFAULT_FIELDS = ["id", "artist", "title", "bpm", "camelot", "rating"] as const;
const MAX_LIMIT = 200;
/**
 * include_total costs ~19x a page (measured: 3.3 ms vs 0.2 ms at 50k tracks),
 * so it is opt-in, and capped rather than exact: a model needs the order of
 * magnitude, not a precise count. Above the cap the total reads as "1000",
 * meaning "at least this many" rather than an exact figure.
 */
const TOTAL_CAP = 1000;

/**
 * Every projected field goes through this allowlist rather than through
 * caller text: the field list becomes part of the SQL (a column name isn't a
 * bindable value), so anything not in here is rejected before it can reach
 * the query. Exported directly (not re-exported later) so a second module
 * validating fields can never drift from this one.
 */
export const FIELD_SQL: Record<string, string> = {
  id: "t.id",
  artist: "t.artist",
  title: "t.title",
  album: "t.album",
  genre: "t.genre",
  comment: "t.comment",
  label: "t.label",
  year: "t.year",
  rating: "t.rating",
  length: "t.length",
  path: "t.path",
  filename: "t.filename",
  bpm: "d.tempo",
  camelot: "d.camelot",
  has_cues: "d.has_cues",
  has_beatgrid: "d.has_grid",
  date_added: "t.dateAdded",
  last_played: "t.timeLastPlayed",
  is_analyzed: "t.isAnalyzed",
};

export const SearchInput = z.object({
  q: z.string().optional(),
  bpm: z
    .object({
      min: z.number().optional(),
      max: z.number().optional(),
      around: z.number().optional(),
      tolerance_pct: z.number().default(3),
    })
    .optional(),
  key: z
    .object({
      camelot: z.array(z.string()).optional(),
      compatible_with: z.string().optional(),
      mode: z.enum(["major", "minor"]).optional(),
    })
    .optional(),
  rating: z.object({ min: z.number().optional(), max: z.number().optional() }).optional(),
  played: z
    .object({
      never: z.boolean().optional(),
      before: z.string().optional(),
      after: z.string().optional(),
    })
    .optional(),
  added: z.object({ before: z.string().optional(), after: z.string().optional() }).optional(),
  flags: z
    .object({
      analyzed: z.boolean().optional(),
      has_cues: z.boolean().optional(),
      has_beatgrid: z.boolean().optional(),
      available: z.boolean().optional(),
    })
    .optional(),
  fields: z.array(z.string()).optional(),
  limit: z.number().int().positive().default(25),
  cursor: z.string().optional(),
  include_total: z.boolean().default(false),
});
export type SearchInput = z.input<typeof SearchInput>;

/** A date is either ISO-8601 or a SQLite relative modifier such as "-6 months". */
function epochExpr(value: string): { sql: string; param: string } {
  const trimmed = value.trim();
  return /^-?\d+\s+(second|minute|hour|day|month|year)s?$/i.test(trimmed)
    ? { sql: "strftime('%s','now',?)", param: trimmed }
    : { sql: "strftime('%s',?)", param: trimmed };
}

/**
 * FTS5 has its own query grammar: AND/OR/NOT, NEAR(...), column filters
 * (`col:term`), and unbalanced quotes are a hard syntax error, not a
 * no-match. A person's search text is not an FTS5 query program, so each
 * whitespace-separated token is wrapped as its own quoted phrase (embedded
 * `"` doubled) before it reaches MATCH. That makes the operator words inert
 * literal tokens instead of syntax, keeps the query always well-formed, and
 * still lets tokens combine with FTS5's implicit AND — a trailing `*` still
 * works as a prefix match since it survives inside the quotes.
 */
function sanitizeFtsQuery(q: string): string {
  return q
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => `"${token.replace(/"/g, '""')}"`)
    .join(" ");
}

function encodeCursor(rank: number | null, rowid: number): string {
  return Buffer.from(JSON.stringify([rank, rowid])).toString("base64url");
}

function decodeCursor(cursor: string): [number | null, number] | null {
  try {
    const v = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!Array.isArray(v) || v.length !== 2) return null;
    const [rank, row] = v;
    if (rank !== null && typeof rank !== "number") return null;
    if (typeof row !== "number") return null;
    return [rank, row];
  } catch {
    return null;
  }
}

export async function searchTracks(
  qp: QueryProcess,
  raw: SearchInput,
): Promise<{ tracks: Record<string, unknown>[]; total?: number; next_cursor?: string } | EngineError> {
  const input = SearchInput.parse(raw);

  const requestedFields = input.fields ?? [...DEFAULT_FIELDS];
  if (requestedFields.length === 0) return err("invalid_argument", "No fields requested");
  const unknownFields = requestedFields.filter((f) => !(f in FIELD_SQL));
  if (unknownFields.length) {
    return err("invalid_argument", `Unknown field(s): ${unknownFields.join(", ")}`, {
      detail: `Recognised fields: ${Object.keys(FIELD_SQL).join(", ")}`,
    });
  }
  const fields = requestedFields;

  const limit = Math.min(input.limit, MAX_LIMIT);
  const useFts = Boolean(input.q && input.q.trim());

  // Filters that scope the result set as a whole (independent of where a
  // page cursor currently sits), so include_total can reuse them without
  // the count shrinking as a caller pages further in.
  const filterWhere: string[] = [];
  const filterParams: unknown[] = [];

  if (useFts) {
    filterWhere.push("f.fts_track MATCH ?");
    filterParams.push(sanitizeFtsQuery(input.q!));
  }

  if (input.bpm) {
    // Key and tempo filters go through the indexed side.track_derived
    // columns (d.tempo / d.camelot below), never through the camelot() or
    // tempo() SQL functions: those run a JS callback per row and force a
    // full scan (measured: 4.3 ms vs 0.06 ms at 50k rows).
    const { min, max, around, tolerance_pct } = input.bpm;
    if (around !== undefined) {
      filterWhere.push("d.tempo BETWEEN ? AND ?");
      filterParams.push(around * (1 - tolerance_pct / 100), around * (1 + tolerance_pct / 100));
    }
    if (min !== undefined) {
      filterWhere.push("d.tempo >= ?");
      filterParams.push(min);
    }
    if (max !== undefined) {
      filterWhere.push("d.tempo <= ?");
      filterParams.push(max);
    }
  }

  if (input.key) {
    const labels = new Set<string>(input.key.camelot ?? []);
    if (input.key.compatible_with) {
      for (const n of camelotNeighbours(input.key.compatible_with)) labels.add(n);
    }
    if (labels.size) {
      filterWhere.push(`d.camelot IN (${[...labels].map(() => "?").join(",")})`);
      filterParams.push(...labels);
    }
    if (input.key.mode) {
      filterWhere.push("d.camelot LIKE ?");
      filterParams.push(input.key.mode === "minor" ? "%A" : "%B");
    }
  }

  if (input.rating?.min !== undefined) {
    filterWhere.push("t.rating >= ?");
    filterParams.push(input.rating.min);
  }
  if (input.rating?.max !== undefined) {
    filterWhere.push("t.rating <= ?");
    filterParams.push(input.rating.max);
  }

  if (input.played?.never) filterWhere.push("(t.timeLastPlayed IS NULL OR t.isPlayed = 0)");
  if (input.played?.before) {
    const e = epochExpr(input.played.before);
    filterWhere.push(`(t.timeLastPlayed IS NULL OR t.timeLastPlayed < ${e.sql})`);
    filterParams.push(e.param);
  }
  if (input.played?.after) {
    const e = epochExpr(input.played.after);
    filterWhere.push(`t.timeLastPlayed >= ${e.sql}`);
    filterParams.push(e.param);
  }

  if (input.added?.after) {
    const e = epochExpr(input.added.after);
    filterWhere.push(`t.dateAdded >= ${e.sql}`);
    filterParams.push(e.param);
  }
  if (input.added?.before) {
    const e = epochExpr(input.added.before);
    filterWhere.push(`t.dateAdded < ${e.sql}`);
    filterParams.push(e.param);
  }

  if (input.flags?.analyzed !== undefined) {
    filterWhere.push("t.isAnalyzed = ?");
    filterParams.push(input.flags.analyzed ? 1 : 0);
  }
  if (input.flags?.available !== undefined) {
    filterWhere.push("t.isAvailable = ?");
    filterParams.push(input.flags.available ? 1 : 0);
  }
  if (input.flags?.has_cues !== undefined) {
    filterWhere.push("d.has_cues = ?");
    filterParams.push(input.flags.has_cues ? 1 : 0);
  }
  if (input.flags?.has_beatgrid !== undefined) {
    filterWhere.push("d.has_grid = ?");
    filterParams.push(input.flags.has_beatgrid ? 1 : 0);
  }

  const from = useFts
    ? `FROM side.fts_track f
       JOIN side.fts_map m ON m.rowid = f.rowid
       JOIN main.Track t ON t.id = m.track_id
       JOIN side.track_derived d ON d.track_id = t.id`
    : `FROM main.Track t JOIN side.track_derived d ON d.track_id = t.id`;

  // Relevance ordering makes ids non-monotonic (measured: 615, 1171, 1727),
  // so a keyset on id alone silently drops or repeats rows between pages.
  // The cursor is the composite (rank, rowid) that ORDER BY actually uses.
  const orderKey = useFts ? "rank" : "t.id";
  const rowKey = useFts ? "f.rowid" : "t.id";

  const pageWhere = [...filterWhere];
  const pageParams = [...filterParams];

  if (input.cursor) {
    const cur = decodeCursor(input.cursor);
    if (!cur) return err("invalid_argument", "Malformed cursor");
    pageWhere.push(`(${orderKey}, ${rowKey}) > (?, ?)`);
    pageParams.push(cur[0], cur[1]);
  }

  const pageWhereSql = pageWhere.length ? `WHERE ${pageWhere.join(" AND ")}` : "";
  const select = fields.map((f) => `${FIELD_SQL[f]} AS "${f}"`).join(", ");
  const sql = `SELECT ${select}, ${orderKey} AS __rank, ${rowKey} AS __row
               ${from} ${pageWhereSql}
               ORDER BY ${orderKey}, ${rowKey} LIMIT ?`;

  const res = await qp.run(sql, [...pageParams, limit]);
  if (isEngineError(res)) return res;

  const idx = Object.fromEntries(res.columns.map((c, i) => [c, i]));
  const tracks = res.rows.map(
    (row) => Object.fromEntries(fields.map((f) => [f, row[idx[f]!]])) as Record<string, unknown>,
  );

  let next_cursor: string | undefined;
  if (res.rows.length === limit) {
    const last = res.rows[res.rows.length - 1]!;
    next_cursor = encodeCursor(last[idx.__rank!] as number | null, Number(last[idx.__row!]));
  }

  let total: number | undefined;
  if (input.include_total) {
    const filterWhereSql = filterWhere.length ? `WHERE ${filterWhere.join(" AND ")}` : "";
    const countSql = `SELECT COUNT(*) AS c FROM (SELECT 1 ${from} ${filterWhereSql} LIMIT ?)`;
    const cres = await qp.run(countSql, [...filterParams, TOTAL_CAP + 1]);
    if (!isEngineError(cres) && cres.rows.length) {
      total = Math.min(Number(cres.rows[0]![0]), TOTAL_CAP);
    }
  }

  return {
    tracks,
    ...(total !== undefined ? { total } : {}),
    ...(next_cursor ? { next_cursor } : {}),
  };
}
