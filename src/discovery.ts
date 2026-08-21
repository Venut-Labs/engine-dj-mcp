import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { err, isEngineError, libraryNeedsRecovery, type EngineError } from "./errors.js";
import { hasHotJournal } from "./store/connections.js";
import { libraryCandidates } from "./paths.js";

export const SUPPORTED_SCHEMAS = ["3.0.0", "3.0.1", "3.0.2"] as const;

export interface LibraryInfo {
  path: string;
  uuid: string;
  schema: [number, number, number];
  supported: boolean;
  trackCount: number | null;
}

export function readLibraryInfo(mdbPath: string): LibraryInfo | EngineError {
  if (!existsSync(mdbPath)) {
    return err("library_not_found", `No Engine library database at ${mdbPath}`);
  }
  if (hasHotJournal(mdbPath)) {
    // Same check openQueryConnection makes before opening (store/connections.ts):
    // recovering a hot journal needs a write, which this project never
    // performs, even to probe a library. Caught here first so the specific,
    // actionable library_needs_recovery reaches the caller instead of the
    // SELECT below failing with the raw "attempt to write a readonly
    // database" and landing in the generic library_unreadable catch --
    // that conflation is exactly what made this condition hard to diagnose
    // in practice.
    return libraryNeedsRecovery();
  }
  let db: DatabaseSync;
  try {
    // A plain path, never a hand-built "file:" URI. SQLite's URI syntax
    // treats `#` and `?` as delimiters, so a library under a folder named
    // `Rock 'n' Roll #1 Mix` truncated at the `#` and failed to open --
    // discoverLibraries then dropped it and the server reported
    // library_not_found, while openQueryConnection on the same file worked.
    // The `readOnly` flag is the actual guarantee; the `?mode=ro` in the URI
    // was redundant with it, and duplicated store/connections.ts's escaping
    // rules badly enough to drift.
    db = new DatabaseSync(mdbPath, { readOnly: true });
  } catch (e) {
    return err("library_busy", "Could not open the Engine library", {
      detail: String((e as Error).message),
      retry_after_ms: 5000,
    });
  }
  try {
    // SELECT * on purpose: the Information column set differs between versions.
    const stmt = db.prepare("SELECT * FROM Information LIMIT 1");
    // Information.currentPlayedIndiciator is a 64-bit value on a real
    // library (measured: -8676408967926364917, far outside
    // Number.MAX_SAFE_INTEGER), and node:sqlite throws instead of returning
    // it unless a statement opts into BigInt reads. Without this, SELECT *
    // threw on every real library and discoverLibraries() silently dropped
    // all of them. Only the small schema/id fields below are ever converted
    // with Number(); nothing here forces an oversized column through it.
    stmt.setReadBigInts(true);
    const row = stmt.get() as Record<string, unknown> | undefined;
    // Not a version problem -- there is no row to read a version from.
    if (!row) return err("library_unreadable", "Information table is empty");

    const schema: [number, number, number] = [
      Number(row.schemaVersionMajor ?? 0),
      Number(row.schemaVersionMinor ?? 0),
      Number(row.schemaVersionPatch ?? 0),
    ];
    const supported = (SUPPORTED_SCHEMAS as readonly string[]).includes(schema.join("."));

    let trackCount: number | null = null;
    try {
      trackCount = Number((db.prepare("SELECT COUNT(*) c FROM Track").get() as any).c);
    } catch {
      trackCount = null; // 1.x has no Track table; still listable.
    }
    return { path: mdbPath, uuid: String(row.uuid ?? ""), schema, supported, trackCount };
  } catch (e) {
    // Whatever this is -- corruption, a permissions problem, a lock the
    // open survived but the read did not -- it was never about the schema
    // version: that is only known once this SELECT has actually returned a
    // row, which it did not. The hot-journal case is carved out above, so
    // this is the genuine remainder.
    return err("library_unreadable", "Could not read Information", {
      detail: String((e as Error).message),
    });
  } finally {
    db.close();
  }
}

export function defaultRoots(): string[] {
  const roots = [join(homedir(), "Music")];
  try {
    for (const vol of readdirSync("/Volumes")) roots.push(join("/Volumes", vol));
  } catch {
    // /Volumes does not exist off macOS; ignore.
  }
  return roots;
}

/** One candidate path's read outcome: either a readable library, or why it
 * currently is not. `path` is always the candidate location, even on
 * failure, so a caller can correlate this against a previous successful
 * probe of the same path. */
export interface LibraryProbe {
  path: string;
  info: LibraryInfo | null;
  error: EngineError | null;
}

/**
 * Walks the same candidate paths as discoverLibraries(), but -- unlike it --
 * reports every candidate that exists on disk, including ones readLibraryInfo
 * could not read right now. discoverLibraries() drops those by design (see
 * below); this is for a caller that needs to tell "not there" apart from
 * "there but currently unreadable", e.g. to keep reporting a library that
 * was seen before while Engine DJ holds a write lock on it.
 */
export function probeLibraries(roots: string[] = defaultRoots()): LibraryProbe[] {
  const out: LibraryProbe[] = [];
  for (const root of roots) {
    for (const candidate of libraryCandidates(root)) {
      if (!existsSync(candidate)) continue;
      const info = readLibraryInfo(candidate);
      out.push(
        isEngineError(info)
          ? { path: candidate, info: null, error: info }
          : { path: candidate, info, error: null },
      );
    }
  }
  return out;
}

/**
 * Reports only libraries it could actually read, by design: a permissions
 * error (or a mid-write lock) on one candidate must not blank out every
 * other one. Built on probeLibraries(); see that function for a version that
 * also reports what could not be read and why.
 */
export function discoverLibraries(roots: string[] = defaultRoots()): LibraryInfo[] {
  return probeLibraries(roots)
    .map((p) => p.info)
    .filter((info): info is LibraryInfo => info !== null);
}
