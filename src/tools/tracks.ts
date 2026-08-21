// src/tools/tracks.ts
import { z } from "zod";
import { err, isEngineError, type EngineError } from "../errors.js";
import { DEFAULT_FIELDS, FIELD_SQL } from "./search.js";
import { redactPath } from "../paths.js";
import type { QueryProcess } from "../proc/query-client.js";

export const GetTracksInput = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(200),
  fields: z.array(z.string()).optional(),
  redact_paths: z.boolean().default(true),
});
export type GetTracksInput = z.input<typeof GetTracksInput>;

export async function getTracks(
  qp: QueryProcess,
  raw: GetTracksInput,
): Promise<{ tracks: Record<string, unknown>[] } | EngineError> {
  const parsed = GetTracksInput.safeParse(raw);
  if (!parsed.success) {
    return err("invalid_argument", "ids must contain between 1 and 200 track ids");
  }
  const { ids, redact_paths } = parsed.data;
  const requestedFields = parsed.data.fields ?? [...DEFAULT_FIELDS];
  // Matches search.ts: an empty projection builds "SELECT , t.id ..." and
  // fails as a raw SQLite syntax error instead of a named argument problem.
  // Omitting `fields` already means "the default projection", so an empty
  // list has no second meaning to honour.
  if (requestedFields.length === 0) return err("invalid_argument", "No fields requested");
  const unknownFields = requestedFields.filter((f) => !(f in FIELD_SQL));
  if (unknownFields.length) {
    return err("invalid_argument", `Unknown field(s): ${unknownFields.join(", ")}`, {
      detail: `Recognised fields: ${Object.keys(FIELD_SQL).join(", ")}`,
    });
  }
  const fields = requestedFields;

  const select = fields.map((f) => `${FIELD_SQL[f]} AS "${f}"`).join(", ");
  const sql = `SELECT ${select}, t.id AS __id
               FROM main.Track t JOIN side.track_derived d ON d.track_id = t.id
               WHERE t.id IN (${ids.map(() => "?").join(",")})`;

  const res = await qp.run(sql, ids);
  if (isEngineError(res)) return res;

  const idx = Object.fromEntries(res.columns.map((c, i) => [c, i]));
  const byId = new Map<number, Record<string, unknown>>();
  for (const row of res.rows) {
    const track = Object.fromEntries(fields.map((f) => {
      const value = row[idx[f]!];
      return [f, redact_paths && f === "path" && typeof value === "string" ? redactPath(value) : value];
    }));
    byId.set(Number(row[idx.__id!]), track);
  }
  // Preserve the caller's ordering; missing ids are simply absent.
  return { tracks: ids.map((id) => byId.get(id)).filter(Boolean) as Record<string, unknown>[] };
}
