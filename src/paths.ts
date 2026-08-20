import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";

export function sidecarDir(uuid: string): string {
  return join(homedir(), ".engine-dj-mcp", uuid);
}

export function sidecarPath(uuid: string): string {
  return join(sidecarDir(uuid), "index.db");
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
