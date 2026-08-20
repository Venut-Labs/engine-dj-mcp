export const ERROR_CODES = [
  "library_busy",
  "library_not_found",
  "unsupported_schema",
  "query_timeout",
  "query_process_crashed",
  "index_stale",
  "decode_failed",
  "invalid_argument",
  "library_needs_recovery",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface EngineError {
  error: ErrorCode;
  message: string;
  detail?: string;
  retry_after_ms?: number;
}

export function err(
  error: ErrorCode,
  message: string,
  extra: Omit<EngineError, "error" | "message"> = {},
): EngineError {
  return { error, message, ...extra };
}

export function isEngineError(value: unknown): value is EngineError {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.message === "string" &&
    typeof v.error === "string" &&
    (ERROR_CODES as readonly string[]).includes(v.error)
  );
}
