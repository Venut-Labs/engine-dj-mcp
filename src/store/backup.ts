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
import { mkdirSync, readdirSync, rmSync } from "node:fs";
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

export async function snapshotLibrary(
  mdbPath: string,
  uuid: string,
  baseDir: string,
): Promise<string | EngineError> {
  let src: DatabaseSync | undefined;
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
    const dest = join(baseDir, `${prefix}${stamp()}.db`);
    await backup(src, dest);
    src.close();
    src = undefined;

    // Snapshots this library owns: the tagged shape above, plus the untagged
    // `${uuid}-${stamp}.db` an earlier version wrote. Without the second,
    // those sat outside every namespace and were never reclaimed -- up to
    // KEEP full copies of a library, kept forever, on any upgrading user.
    // They predate the tag and therefore predate everything written since,
    // which is why folding them into one window evicts them first. Two
    // libraries sharing a uuid is precisely why the tag exists, and an
    // untagged file cannot say which of them it came from -- ageing them out
    // under whichever library writes next is the only thing left to do.
    const legacy = new RegExp(`^${uuid}-\\d{4}-`);
    const mine = readdirSync(baseDir)
      .filter((f) => f.endsWith(".db") && (f.startsWith(prefix) || legacy.test(f)))
      .sort();
    for (const old of mine.slice(0, Math.max(0, mine.length - KEEP))) {
      rmSync(join(baseDir, old), { force: true });
    }
    return dest;
  } catch (e) {
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
