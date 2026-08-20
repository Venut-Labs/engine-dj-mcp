// src/tools/tracks.ts
import { z } from "zod";
import { err, isEngineError, type EngineError } from "../errors.js";
import { DEFAULT_FIELDS, FIELD_SQL } from "./search.js";
import type { QueryProcess } from "../proc/query-client.js";

export const GetTracksInput = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(200),
  fields: z.array(z.string()).optional(),
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
  const { ids } = parsed.data;
  const fields = (parsed.data.fields ?? [...DEFAULT_FIELDS]).filter((f) => f in FIELD_SQL);
  if (!fields.length) return err("invalid_argument", "No recognised fields requested");

  const select = fields.map((f) => `${FIELD_SQL[f]} AS "${f}"`).join(", ");
  const sql = `SELECT ${select}, t.id AS __id
               FROM main.Track t JOIN side.track_derived d ON d.track_id = t.id
               WHERE t.id IN (${ids.map(() => "?").join(",")})`;

  const res = await qp.run(sql, ids);
  if (isEngineError(res)) return res;

  const idx = Object.fromEntries(res.columns.map((c, i) => [c, i]));
  const byId = new Map<number, Record<string, unknown>>();
  for (const row of res.rows) {
    byId.set(Number(row[idx.__id!]), Object.fromEntries(fields.map((f) => [f, row[idx[f]!]])));
  }
  // Preserve the caller's ordering; missing ids are simply absent.
  return { tracks: ids.map((id) => byId.get(id)).filter(Boolean) as Record<string, unknown>[] };
}
