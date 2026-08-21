// tests/fixtures/hot-journal-writer.js
//
// Run only as a forked child process (see readonly-guarantees.test.ts). Forces
// a *hot* rollback journal: with the page cache capped far below the dirty
// page count, the in-progress UPDATE must spill pages to the on-disk journal
// (writing SQLite's real journal-header magic) before the transaction ever
// commits. The parent SIGKILLs this process once it signals readiness, so
// the journal is left exactly as SQLite wrote it mid-transaction — no
// rollback, no commit, nothing cleaned up.
import { DatabaseSync } from "node:sqlite";

const dbPath = process.argv[2];
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = DELETE");
db.exec("PRAGMA cache_size = 20");
db.exec("BEGIN IMMEDIATE");
db.exec("UPDATE Track SET rating = 2");
if (process.send) process.send("ready");
// Block forever; must never exit on its own or the journal gets cleaned up.
setInterval(() => {}, 1000);
