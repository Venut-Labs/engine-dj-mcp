// src/store/backup.ts
//
// A snapshot taken before the first write of a session, so a user who does
// not like the result has a known way back. It is taken through SQLite's own
// backup API rather than a file copy: that is correct even while Engine DJ
// holds the database open, which a cp is not.
//
// Snapshots live under ~/.engine-dj-mcp/backups/ and never inside the user's
// Engine Library folder -- the rule that no file is created there holds for
// writes exactly as it did for reads.
import { DatabaseSync, backup } from "node:sqlite";
import { mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { err, type EngineError } from "../errors.js";
import { libraryTag } from "../paths.js";

/** How many snapshots to keep per library before deleting the oldest. */
const KEEP = 10;

/**
 * Monotonic counter to ensure unique, sortable filenames even in tight loops.
 * The ISO string alone provides only millisecond precision, so rapid-fire calls
 * in the same millisecond would collide. The counter serves as an infallible
 * tiebreaker: calls within the same millisecond are ordered by counter value,
 * and calls across milliseconds are already separated by the ISO string. This
 * ordering is essential: rotation immediately deletes the text-sorted oldest,
 * so an inverted sort would delete the snapshot we just handed back.
 */
let counter = 0;

/**
 * A filename-safe, sortable stamp. Sorting the directory listing as text
 * therefore orders snapshots by age, which is what rotation relies on.
 */
function stamp(): string {
  const iso = new Date().toISOString().replace(/[:.]/g, "-");
  return `${iso}-${String(++counter).padStart(10, "0")}`;
}

/**
 * The snapshots to delete, oldest first, from a directory listing.
 *
 * Two name shapes live here: the tagged `${uuid}-${tag}-${stamp}.db` written
 * now, and the untagged `${uuid}-${stamp}.db` an earlier version wrote.
 * Without the second, those sat outside every namespace and were never
 * reclaimed -- up to KEEP full copies of a library, kept forever, on any
 * upgrading user. Two libraries sharing a uuid is precisely why the tag
 * exists, and an untagged file cannot say which of them it came from, so
 * ageing them out under whichever library writes next is the only thing left
 * to do with them.
 *
 * Ordering is by the stamp alone, never by the whole filename. Sorting the
 * names as text compares a tag against a year at the same offset, and a tag
 * is hex: `1e269292c523` sorts *before* `2026-...`, so a library whose path
 * happens to hash to a tag starting 0 or 1 had its newest snapshot land at
 * the head of the list and be deleted -- the file the caller had just been
 * handed as its way back. Measured: it passed locally under the tag
 * `cf11e2d00f88` and failed in CI under `1e269292c523`, same code.
 *
 * Untagged files sort before every tagged one regardless of stamp: they
 * predate the tagged scheme, so they predate anything written since.
 */
export function evictable(names: string[], uuid: string, tag: string): string[] {
  const tagged = `${uuid}-${tag}-`;
  const legacy = new RegExp(`^${uuid}-(\\d{4}-.*)\\.db$`);
  const mine: { name: string; old: boolean; stamp: string }[] = [];
  for (const name of names) {
    if (!name.endsWith(".db")) continue;
    if (name.startsWith(tagged)) {
      mine.push({ name, old: false, stamp: name.slice(tagged.length, -3) });
      continue;
    }
    const m = legacy.exec(name);
    if (m) mine.push({ name, old: true, stamp: m[1]! });
  }
  mine.sort((a, b) => (a.old !== b.old ? (a.old ? -1 : 1) : a.stamp < b.stamp ? -1 : a.stamp > b.stamp ? 1 : 0));
  return mine.slice(0, Math.max(0, mine.length - KEEP)).map((x) => x.name);
}

/** Whether a process with this pid exists. EPERM means it does and is not ours to signal. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Partial copies in this library's namespace whose writer is gone.
 *
 * A snapshot is copied to `<final name>.partial-<pid>` and renamed into place
 * only once backup() has resolved (see snapshotLibrary). A process killed
 * mid-copy never gets to clean up after itself, so its partial stays behind:
 * harmless to rotation, which counts only `.db` names, but a full-size file
 * nobody will ever finish.
 *
 * The pid is what separates such an orphan from another server's copy that is
 * being written right now -- two servers can snapshot one library at once --
 * so only a pid with no live process behind it is reclaimed. `prefix` keeps it
 * to this library, exactly as rotation is kept to it.
 */
export function abandonedPartials(
  names: string[],
  prefix: string,
  isAlive: (pid: number) => boolean = processAlive,
): string[] {
  // With or without `-journal`: SQLite keeps a rollback journal beside the
  // copy while backup() runs (measured -- it exists mid-copy and is gone once
  // backup() resolves), so a process killed partway leaves both behind. They
  // share the pid, so a live copy's journal is spared along with the copy.
  const partial = /\.db\.partial-(\d+)(-journal)?$/;
  return names.filter((name) => {
    if (!name.startsWith(prefix)) return false;
    const m = partial.exec(name);
    return m !== null && !isAlive(Number(m[1]));
  });
}

export async function snapshotLibrary(
  mdbPath: string,
  uuid: string,
  baseDir: string,
  // Injectable so a test can make the copy fail after it has started writing
  // -- the one failure that matters here, and one no real error reachable
  // from a test produces (they all fail before the destination is touched).
  deps: { backup?: typeof backup } = {},
): Promise<string | EngineError> {
  const copy = deps.backup ?? backup;
  // node:sqlite stopped needing a flag in 22.13, which is where this
  // project's floor used to sit -- but backup() only arrived in 22.16. On
  // 22.13 through 22.15 the read path works perfectly and this one throws
  // "backup is not a function", which is what CI reported on its very first
  // run against the declared floor. `engines` now says 22.16, and npm only
  // enforces that under engine-strict, so the check is here too: a version
  // number a user can act on beats a TypeError from inside a dependency.
  if (typeof copy !== "function") {
    return err(
      "library_unreadable",
      `This Node cannot snapshot a library before writing to it: node:sqlite gained backup() in ` +
        `22.16.0 and this is ${process.version}. Upgrade Node, or run without --allow-writes.`,
    );
  }

  let src: DatabaseSync | undefined;
  let partial: string | undefined;
  try {
    mkdirSync(baseDir, { recursive: true });
    src = new DatabaseSync(mdbPath, { readOnly: true });
    // uuid *and* a hash of the file's own path. Keyed on uuid alone, a
    // library and its clone on a second drive -- same uuid, different drive,
    // an ordinary thing for a DJ to have -- shared one namespace and one
    // KEEP-slot window: writes to either evicted the other's snapshots, and
    // a returned backup_path did not say which drive it came from. This is
    // the same tag server.ts's sidecarBaseFor uses to keep two such
    // libraries' indexes apart (see paths.ts).
    const prefix = `${uuid}-${libraryTag(mdbPath)}-`;

    // Before copying, not after: a copy that died because the disk filled up
    // left its partial behind, and this is exactly when that space is wanted.
    for (const dead of abandonedPartials(readdirSync(baseDir), prefix)) {
      rmSync(join(baseDir, dead), { force: true });
    }

    // Copied under a name rotation does not count and nobody would restore,
    // then renamed into place only once backup() has resolved. Written
    // straight to the final name, a copy that died partway was an incomplete
    // database indistinguishable from a good one: rotation took it for the
    // newest and evicted a real snapshot for it, and "restore the latest
    // backup" would have restored it (#3). rename() within one directory is
    // atomic, so the final name only ever holds a finished copy.
    const dest = join(baseDir, `${prefix}${stamp()}.db`);
    partial = `${dest}.partial-${process.pid}`;
    await copy(src, partial);
    src.close();
    src = undefined;
    renameSync(partial, dest);
    partial = undefined;

    for (const stale of evictable(readdirSync(baseDir), uuid, libraryTag(mdbPath))) {
      rmSync(join(baseDir, stale), { force: true });
    }
    return dest;
  } catch (e) {
    // Safe to delete, which the destination itself never was: this name
    // carries this process's pid and a stamp whose counter never repeats
    // within a process, so whatever is there was created by this call. The
    // earlier objection to cleaning up on failure -- deleting a file at a path
    // we may not have created -- does not apply to a path no one else can
    // produce.
    if (partial) {
      rmSync(partial, { force: true });
      rmSync(`${partial}-journal`, { force: true });
    }
    return err(
      "library_unreadable",
      `Could not snapshot ${mdbPath} before writing: ${String(e)}`,
    );
  } finally {
    try {
      src?.close();
    } catch {
      /* already closed */
    }
  }
}
