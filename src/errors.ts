export const ERROR_CODES = [
  "library_busy",
  "library_not_found",
  // The library was found and opened, but a read against it failed for a
  // reason that has nothing to do with schema version -- corruption, a
  // permissions problem, an oversized column node:sqlite refuses to convert.
  // Distinct from unsupported_schema (below), which is specifically "this
  // version is outside the allowlist", and from library_needs_recovery,
  // which is specifically a hot journal: discovery.ts checks for that first
  // and reports it precisely, so this is only the remainder. Previously
  // every one of these landed on unsupported_schema, which sent debugging
  // toward "check the schema version" for a failure that was never about
  // the schema at all.
  "library_unreadable",
  "unsupported_schema",
  "query_timeout",
  "query_process_crashed",
  "index_stale",
  "decode_failed",
  "invalid_argument",
  "library_needs_recovery",
  // Write-path codes. There is no writes_not_enabled code: the tool is not
  // registered at all without --allow-writes, and the MCP SDK's own
  // dispatcher rejects a call to an unregistered tool name before any
  // handler in this project runs, so this project never gets the chance to
  // report that condition itself.
  "playlist_exists",
  "unknown_track",
  "duplicate_track",
  // Editing an existing playlist. playlist_chain_damaged is the one that
  // matters: a chain with a cycle or a severed link cannot be edited without
  // making it worse, and the edit would not notice.
  "playlist_chain_damaged",
  "playlist_not_found",
  "invalid_position",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface EngineError {
  error: ErrorCode;
  message: string;
  /**
   * Free text almost everywhere (store/index-manager.ts passes a raw
   * `e.message` through it), with one exception that is part of the tool
   * contract: on an error from the write path (store/write.ts) this is
   * always exactly `"not_committed"` -- the library is byte-for-byte what it
   * was -- or `"committed_unverified"` -- the write may have landed and could
   * not be confirmed, and `backup_path` below is then set. Those two strings
   * are reserved on that path and must stay stable, because a client reads
   * them to decide whether their library changed.
   */
  detail?: string;
  retry_after_ms?: number;
  /**
   * Path to a pre-write snapshot the caller can restore from. Only ever set
   * by the write path, and only on the errors a client cannot safely ignore:
   * `detail === "committed_unverified"`. It is a whole-database snapshot, so
   * restoring it is a recovery route for a damaged library and not an undo
   * of one playlist -- it reverts everything Engine DJ wrote since it was
   * taken.
   */
  backup_path?: string;
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
