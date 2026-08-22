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

/** How many snapshots to keep per library before deleting the oldest. */
const KEEP = 10;

/**
 * A filename-safe, sortable stamp. Sorting the directory listing as text
 * therefore orders snapshots by age, which is what rotation relies on.
 * Nanosecond precision ensures uniqueness even in tight loops.
 */
function stamp(): string {
  const iso = new Date().toISOString().replace(/[:.]/g, "-");
  const nano = String(process.hrtime.bigint() % 1000000000n).padStart(9, "0");
  return `${iso}-${nano}`;
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
    const dest = join(baseDir, `${uuid}-${stamp()}.db`);
    await backup(src, dest);
    src.close();
    src = undefined;

    const mine = readdirSync(baseDir)
      .filter((f) => f.startsWith(`${uuid}-`) && f.endsWith(".db"))
      .sort();
    for (const old of mine.slice(0, Math.max(0, mine.length - KEEP))) {
      rmSync(join(baseDir, old), { force: true });
    }
    return dest;
  } catch (e) {
    return err(
      "library_unreadable",
      `Could not snapshot ${mdbPath} before writing: ${(e as Error).message}`,
    );
  } finally {
    try {
      src?.close();
    } catch {
      /* already closed */
    }
  }
}
