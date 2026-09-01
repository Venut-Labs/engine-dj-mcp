// src/library-select.ts
import { resolve } from "node:path";
import { z } from "zod";
import { err, type EngineError } from "./errors.js";
import type { LibraryInfo } from "./discovery.js";
import { expandHome, redactPath } from "./paths.js";

/**
 * The `library` argument every library-touching tool accepts. Optional
 * everywhere: a DJ with one library must never have to name it.
 *
 * Both a uuid and a path are accepted because `list_libraries` reports both,
 * and neither a person nor a model can be expected to know which of the two
 * fields is the "real" identifier. The description says so explicitly --
 * a model reads this string and nothing else before choosing what to pass.
 */
export const LIBRARY_ARG_DESCRIPTION =
  "Which library to use: either the uuid or the path reported by list_libraries " +
  "(the reported ~/... form is accepted, as is the absolute path). Omit it to use " +
  "the supported library holding the most tracks. If two supported libraries hold " +
  "the same most tracks -- what a USB drive and its copy on the computer produce -- " +
  "a read still picks one, but a WRITE refuses with ambiguous_library listing both, " +
  "since the choice decides which disk changes; pass this argument to settle it.";

export const LibraryArg = z.string().min(1).optional().describe(LIBRARY_ARG_DESCRIPTION);

/**
 * The default when no `library` was given: the supported library with the
 * most tracks.
 *
 * Root-scan order -- the previous rule -- puts ~/Music ahead of /Volumes,
 * so a DJ whose real collection lives on a USB drive got the near-empty
 * local library that Engine DJ creates on install, with no way to ask for
 * the other one. Track count is the one signal available at discovery time
 * that actually tracks "the library this person works in".
 *
 * Ties break on root-scan order, so the choice is deterministic rather than
 * dependent on Map or filesystem iteration order. `trackCount` is null only
 * when the Track table could not be read at all (a 1.x library); such a
 * library is never `supported`, but treat null as "fewer than zero tracks"
 * anyway so a known count always beats an unknown one.
 *
 * Falls back to the first library of any kind -- including an unsupported
 * one -- so that ensureFresh's specific, actionable `unsupported_schema`
 * reaches the caller instead of the generic `library_not_found` that "no
 * supported library" would otherwise collapse into.
 */
export function pickDefaultLibrary(libs: readonly LibraryInfo[]): LibraryInfo | null {
  let best: LibraryInfo | null = null;
  for (const lib of libs) {
    if (!lib.supported) continue;
    if (best === null || (lib.trackCount ?? -1) > (best.trackCount ?? -1)) best = lib;
  }
  return best ?? libs[0] ?? null;
}

/**
 * The supported libraries tied for the default pick -- more than one holding
 * the same, highest track count. Empty when the default is unambiguous, which
 * includes the single-library case every DJ starts from.
 *
 * A tie is not an exotic shape: it is what a USB drive and its copy on the
 * computer produce, and they tie *because* one is a copy of the other.
 * Measured 2026-09-01, both real libraries reported 257 tracks.
 *
 * For a read, either answer is very nearly the same answer -- the two are
 * copies -- so `pickDefaultLibrary` keeps choosing, and a read never has to
 * name a library it does not care about. For a write the choice decides which
 * physical disk changes, and one of them is the drive the DJ performs from.
 * Hence: reads choose, writes refuse. Callers wanting the strict behaviour
 * check this first.
 *
 * Skips unsupported libraries for the same reason `pickDefaultLibrary` does:
 * one can never be chosen while a supported library exists, so it is not a
 * competing candidate and must not make a write refuse.
 */
export function defaultLibraryTies(libs: readonly LibraryInfo[]): LibraryInfo[] {
  const supported = libs.filter((l) => l.supported);
  if (supported.length < 2) return [];
  const best = Math.max(...supported.map((l) => l.trackCount ?? -1));
  const tied = supported.filter((l) => (l.trackCount ?? -1) === best);
  return tied.length > 1 ? tied : [];
}

/**
 * The refusal for an ambiguous default on a write.
 *
 * Every candidate is named, with its track count, because the caller has to
 * pick one and cannot do that from "it was ambiguous" -- the same reason
 * get_playlist_tracks lists candidates for an ambiguous playlist name.
 *
 * The list goes in `message`, never in `detail`. This is only ever returned
 * from a write tool, and on that path `detail` carries exactly
 * `"not_committed"` or `"committed_unverified"` -- a client reads it to
 * decide whether its library changed. Prose there would break that read for
 * the one error whose answer is least in doubt: nothing was opened, let alone
 * written.
 */
export function ambiguousLibrary(tied: readonly LibraryInfo[]): EngineError {
  const list = tied.map((l) => `${l.uuid} -- ${redactPath(l.path)} (${l.trackCount} tracks)`).join("; ");
  return err(
    "ambiguous_library",
    `More than one library holds the most tracks, so there is no default to write to. ` +
      `Pass \`library\` naming one of: ${list}. Nothing was written.`,
    { detail: "not_committed" },
  );
}

/**
 * Resolves a caller-supplied `library` value: uuid first, then filesystem
 * path. Returns null when it matches neither -- the caller decides what
 * kind of error that is, since it also knows what else is (or is not) on
 * this machine.
 *
 * uuid comparison is case- and whitespace-insensitive: Engine writes uuids
 * in one case and a caller may well retype or re-case one. Path comparison
 * goes through expandHome + resolve, so `~/Music/...` (the form
 * list_libraries prints), the absolute form, and a path with a redundant
 * `.` or trailing separator all name the same library.
 *
 * A path match is exact on the m.db file, not a prefix: a value that merely
 * *contains* a library path must not select it.
 */
export function findLibrary(libs: readonly LibraryInfo[], requested: string): LibraryInfo | null {
  const wanted = requested.trim();
  if (!wanted) return null;

  const byUuid = libs.find((l) => l.uuid && l.uuid.toLowerCase() === wanted.toLowerCase());
  if (byUuid) return byUuid;

  // resolve() turns a relative value into something rooted at the process
  // cwd, which matches no library path -- exactly the intended outcome for
  // a value that is neither a uuid nor a real path.
  const wantedPath = resolve(expandHome(wanted));
  return libs.find((l) => resolve(l.path) === wantedPath) ?? null;
}

/**
 * The error for a `library` value that matched nothing. It names what was
 * passed and lists what is actually selectable, because the two ways to get
 * here -- a typo, and a drive that is no longer mounted -- are told apart by
 * seeing the list, not by being told "not found".
 *
 * Deliberately reuses `library_not_found` rather than introducing a code:
 * the taxonomy is closed, and this is the same condition ("the library you
 * are asking about is not here") arrived at from a different direction.
 */
export function libraryNotFound(requested: string, libs: readonly LibraryInfo[]): EngineError {
  const known = libs.filter((l) => l.uuid);
  return err("library_not_found", `No Engine DJ library matches "${requested}"`, {
    detail: known.length
      ? `Known libraries (uuid -- path): ${known
          .map((l) => `${l.uuid} -- ${redactPath(l.path)}`)
          .join("; ")}. Pass a uuid or a path exactly as list_libraries reports it.`
      : "No Engine DJ library was discovered on this machine; call list_libraries to see what is visible.",
  });
}
