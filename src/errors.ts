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

/**
 * The single source for this text. It was previously written out by hand in
 * three files, and the one place that built a structured error (connections.ts)
 * threw away everything but `.message` -- forcing query-client.ts to re-stat
 * the disk to work out which condition it was looking at.
 */
export const LIBRARY_NEEDS_RECOVERY_MESSAGE =
  "The Engine library was closed uncleanly and has an unrecovered journal. " +
  "Launch Engine DJ once so it can recover the library, then retry.";

export function libraryNeedsRecovery(): EngineError {
  return err("library_needs_recovery", LIBRARY_NEEDS_RECOVERY_MESSAGE);
}

/**
 * An EngineError travelling as an exception, for the one place that has to
 * throw: openQueryConnection runs inside the forked worker, where a return
 * value has nowhere to go. The structured error rides along intact --
 * across the IPC boundary too, since the worker forwards `engineError` in
 * its startup-failure message -- so no caller has to re-derive the condition
 * by string-matching a message or by going back to the filesystem.
 */
export class EngineErrorException extends Error {
  constructor(readonly engineError: EngineError) {
    super(engineError.message);
    this.name = "EngineErrorException";
  }
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
