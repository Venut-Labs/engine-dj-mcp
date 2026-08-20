// src/tools/libraries.ts
import { discoverLibraries, SUPPORTED_SCHEMAS, type LibraryInfo } from "../discovery.js";

export interface LibraryReport {
  path: string; uuid: string; schema: string; supported: boolean;
  track_count: number | null; index_generation: number | null;
}

/**
 * Always succeeds, including for unsupported schemas: a user staring at an
 * empty list cannot tell a broken server from a missing library.
 */
export function listLibraries(
  generations: Map<string, number> = new Map(),
  libs: LibraryInfo[] = discoverLibraries(),
): { libraries: LibraryReport[]; supported_schemas: string[] } {
  return {
    libraries: libs.map((l) => ({
      path: l.path,
      uuid: l.uuid,
      schema: l.schema.join("."),
      supported: l.supported,
      track_count: l.trackCount,
      index_generation: generations.get(l.uuid) ?? null,
    })),
    supported_schemas: [...SUPPORTED_SCHEMAS],
  };
}
