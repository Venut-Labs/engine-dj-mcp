import { openSync, readSync, closeSync } from "node:fs";

/**
 * The SQLite file-change counter: 4 bytes big-endian at offset 24 of the
 * database header. It increments on every write transaction, is part of the
 * on-disk format, and survives process restarts — unlike PRAGMA data_version,
 * which only tracks changes within the life of one connection.
 */
export function readChangeCounter(dbPath: string): number {
  const fd = openSync(dbPath, "r");
  try {
    const buf = Buffer.alloc(28);
    const read = readSync(fd, buf, 0, 28, 0);
    if (read < 28) throw new Error(`${dbPath}: file too short to be a SQLite database`);
    return buf.readUInt32BE(24);
  } finally {
    closeSync(fd);
  }
}
