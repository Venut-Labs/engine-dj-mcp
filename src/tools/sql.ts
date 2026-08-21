// src/tools/sql.ts
import { z } from "zod";
import { checkStatement, enforceLimit } from "../guard.js";
import { isEngineError, type EngineError } from "../errors.js";
import type { QueryProcess } from "../proc/query-client.js";

export const RunSqlInput = z.object({
  sql: z.string().min(1),
  params: z.array(z.union([z.string(), z.number(), z.null()])).optional(),
  limit: z.number().int().positive().max(500).default(200),
});
export type RunSqlInput = z.input<typeof RunSqlInput>;

export async function runSql(
  qp: QueryProcess,
  raw: RunSqlInput,
): Promise<{ columns: string[]; rows: unknown[][]; truncated: boolean } | EngineError> {
  const input = RunSqlInput.parse(raw);
  const rejected = checkStatement(input.sql);
  if (rejected) return rejected;

  // prepare() only, never exec(): exec() runs every chained statement and would
  // let "SELECT 1; VACUUM INTO ..." slip past the guard above.
  const res = await qp.run(enforceLimit(input.sql, input.limit), input.params ?? []);
  if (isEngineError(res)) return res;
  return { ...res, truncated: res.rows.length >= input.limit };
}
