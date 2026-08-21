// src/tools/libraries.ts
import { discoverLibraries, SUPPORTED_SCHEMAS, type LibraryInfo } from "../discovery.js";
import { redactPath } from "../paths.js";
import type { EngineError } from "../errors.js";

/**
 * A library entry as reported to a caller. `unreadable` is set when the most
 * recent scan could not actually read this candidate (e.g. Engine DJ holds a
 * write lock on it right now); the rest of the fields then still carry the
 * last known-good read, the same way `supported: false` carries a library's
 * version rather than hiding it -- so a caller can tell a broken server from
 * a missing library, and now "present but unreadable" from "present and
 * fine" too. Plain LibraryInfo (no `unreadable`) is always a valid entry.
 */
export type LibraryEntry = LibraryInfo & { unreadable?: EngineError };

export interface LibraryReport {
  path: string; uuid: string; schema: string; supported: boolean;
  track_count: number | null; index_generation: number | null;
  status: "ok" | "unreadable";
  error: EngineError | null;
}

/**
 * Always succeeds, including for unsupported schemas: a user staring at an
 * empty list cannot tell a broken server from a missing library. A library
 * that was discoverable before must not silently disappear because it is
 * momentarily unreadable either -- see `status`/`error` below and
 * LibraryEntry's `unreadable`.
 *
 * `path` is the absolute location of `m.db`, which carries the user's
 * account name (see src/paths.ts's `redactPath`) -- unlike Track.path
 * elsewhere in this codebase, this one really is routinely absolute, so
 * redaction here is not defence in depth, it is the primary case.
 */
export function listLibraries(
  generations: Map<string, number> = new Map(),
  libs: LibraryEntry[] = discoverLibraries(),
): { libraries: LibraryReport[]; supported_schemas: string[] } {
  return {
    libraries: libs.map((l) => ({
      path: redactPath(l.path),
      uuid: l.uuid,
      schema: l.schema.join("."),
      supported: l.supported,
      track_count: l.trackCount,
      index_generation: generations.get(l.uuid) ?? null,
      status: l.unreadable ? ("unreadable" as const) : ("ok" as const),
      error: l.unreadable ?? null,
    })),
    supported_schemas: [...SUPPORTED_SCHEMAS],
  };
}
