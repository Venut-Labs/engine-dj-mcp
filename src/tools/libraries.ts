// src/tools/libraries.ts
import { discoverLibraries, SUPPORTED_SCHEMAS, type LibraryInfo } from "../discovery.js";
import { redactPath } from "../paths.js";

export interface LibraryReport {
  path: string; uuid: string; schema: string; supported: boolean;
  track_count: number | null; index_generation: number | null;
}

/**
 * Always succeeds, including for unsupported schemas: a user staring at an
 * empty list cannot tell a broken server from a missing library.
 *
 * `path` is the absolute location of `m.db`, which carries the user's
 * account name (see src/paths.ts's `redactPath`) -- unlike Track.path
 * elsewhere in this codebase, this one really is routinely absolute, so
 * redaction here is not defence in depth, it is the primary case.
 */
export function listLibraries(
  generations: Map<string, number> = new Map(),
  libs: LibraryInfo[] = discoverLibraries(),
): { libraries: LibraryReport[]; supported_schemas: string[] } {
  return {
    libraries: libs.map((l) => ({
      path: redactPath(l.path),
      uuid: l.uuid,
      schema: l.schema.join("."),
      supported: l.supported,
      track_count: l.trackCount,
      index_generation: generations.get(l.uuid) ?? null,
    })),
    supported_schemas: [...SUPPORTED_SCHEMAS],
  };
}
