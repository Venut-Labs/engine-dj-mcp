import { err, type EngineError } from "./errors.js";

const FORBIDDEN = /^\s*(VACUUM|ATTACH|DETACH)\b/i;
const WRITE_PRAGMA = /^\s*PRAGMA\s+(?!table_info|table_list|index_list|index_info|foreign_key_list)/i;

/**
 * run_sql executes through prepare(), which ignores everything after the first
 * semicolon. exec() runs every statement and would let "SELECT 1; VACUUM INTO"
 * slip past a leading-statement check, so run_sql must never use it. We still
 * reject chained statements outright, because a query that relies on the tail
 * being dropped is a query whose author misunderstood what will run.
 */
export function checkStatement(sql: string): EngineError | null {
  const trimmed = sql.trim().replace(/;\s*$/, "");
  if (trimmed.includes(";")) {
    return err("invalid_argument", "Only a single SQL statement is allowed", { detail: sql });
  }
  if (FORBIDDEN.test(trimmed)) {
    return err("invalid_argument", "VACUUM, ATTACH and DETACH are not permitted", { detail: sql });
  }
  if (WRITE_PRAGMA.test(trimmed)) {
    return err("invalid_argument", "Only read-only PRAGMA introspection is permitted", { detail: sql });
  }
  return null;
}

export function enforceLimit(sql: string, limit: number): string {
  return /\blimit\b/i.test(sql) ? sql : `${sql.trim().replace(/;\s*$/, "")} LIMIT ${limit}`;
}
