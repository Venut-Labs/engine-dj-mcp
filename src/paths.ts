import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";

export function sidecarDir(uuid: string): string {
  return join(homedir(), ".engine-dj-mcp", uuid);
}

/** Engine stores Track.path relative to the `Engine Library` folder, usually with `..`. */
export function absTrackPath(mdbPath: string, relative: string): string {
  const engineLibrary = dirname(dirname(mdbPath)); // .../Engine Library/Database2/m.db
  return resolve(engineLibrary, relative);
}

/** Candidate locations of `m.db` beneath a filesystem root. */
export function libraryCandidates(root: string): string[] {
  return [join(root, "Engine Library", "Database2", "m.db")];
}

/**
 * Absolute library paths carry the user's account name. Search results are
 * shipped to a model provider, so the home prefix is folded to `~` by default.
 */
export function redactPath(p: string): string {
  const home = homedir();
  return p === home || p.startsWith(home + "/") ? "~" + p.slice(home.length) : p;
}

/**
 * The inverse of redactPath, for values coming back *in*. Every library path
 * this server reports has been through redactPath, so the most obvious way
 * to name a library -- copy the `path` list_libraries just printed -- hands
 * back a `~/...` string that exists on no filesystem. Anything without a
 * leading `~` is returned untouched, so an absolute path stays absolute.
 */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}
