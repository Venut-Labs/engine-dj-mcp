// tests/readonly-guarantees.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readdirSync,
  renameSync,
  mkdirSync,
  writeFileSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fork } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { makeLibrary } from "./fixtures/gen-library.js";
import {
  openQueryConnection,
  openSyncConnection,
  reattachSidecar,
  hasHotJournal,
} from "../src/store/connections.js";

const HOT_JOURNAL_MAGIC = "d9d505f920a163d7";
const hotWriterScript = fileURLToPath(new URL("./fixtures/hot-journal-writer.js", import.meta.url));

let dir: string, mdb: string, side: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "edj-ro-"));
  mdb = makeLibrary(dir, { tracks: 100 });
  side = join(dir, "side.db");
  const s = new DatabaseSync(side);
  s.exec("CREATE TABLE marker(v TEXT)");
  s.exec("INSERT INTO marker VALUES('old')");
  s.close();
});
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

describe("read-only is a kernel guarantee", () => {
  it("refuses a write after re-attaching the same database without mode=ro", () => {
    const db = openQueryConnection(mdb, side);
    let wrote = false;
    try {
      db.exec(`ATTACH DATABASE '${mdb}' AS rw`);
      db.exec("CREATE TABLE rw.pwned(x)");
      wrote = true;
    } catch { /* expected */ }
    db.close();
    expect(wrote).toBe(false);
  });

  it("refuses WITH ... INSERT, which defeats any prefix check", () => {
    const db = openQueryConnection(mdb, side);
    // id 999999 does not collide with the fixture's 1..100 track ids, so this
    // can only fail because the connection is read-only — not because a
    // fully-writable connection would hit the same UNIQUE constraint anyway.
    expect(() =>
      db.prepare("WITH s AS (SELECT 999999 v) INSERT INTO Track(id) SELECT v FROM s").run(),
    ).toThrow(/readonly/i);
    db.close();
  });

  it("executes only the first statement when several are chained", () => {
    const db = openQueryConnection(mdb, side);
    // prepare() ignores everything past the first semicolon. run_sql relies on
    // this; exec() does NOT behave this way and must never be used there.
    const row = db.prepare("SELECT 1 AS a; SELECT 2 AS a").get() as any;
    expect(row.a).toBe(1);
    db.close();
  });

  it("refuses plain VACUUM at the kernel level", () => {
    const db = openQueryConnection(mdb, side);
    expect(() => db.exec("VACUUM")).toThrow();
    db.close();
  });

  it("tolerates a concurrent writer holding an open transaction, without exposing its uncommitted rows", () => {
    // COUNT(*) is identical whether or not the reader can see the writer's
    // uncommitted UPDATE, so it never discriminated between "reads through
    // the transaction" and "reads a genuinely wrong value". SUM(rating) does:
    // the holder sets an out-of-range sentinel, so any leak of the
    // uncommitted state changes the sum.
    const before = new DatabaseSync(mdb, { readOnly: true });
    const baseline = (before.prepare("SELECT SUM(rating) s FROM Track").get() as any).s;
    before.close();

    const holder = new DatabaseSync(mdb);
    holder.exec("BEGIN IMMEDIATE");
    holder.exec("UPDATE Track SET rating = 999 WHERE id < 10");
    const db = openQueryConnection(mdb, side);
    const sum = (db.prepare("SELECT SUM(rating) s FROM Track").get() as any).s;
    expect(sum).toBe(baseline);
    db.close();
    holder.exec("ROLLBACK");
    holder.close();
  });

  it("creates no files next to the user's database", () => {
    const db2 = join(dir, "Engine Library", "Database2");
    const before = new Set(readdirSync(db2));
    const db = openQueryConnection(mdb, side);
    db.prepare("SELECT COUNT(*) c FROM Track").get();
    db.close();
    const after = readdirSync(db2).filter((f) => !before.has(f));
    expect(after).toEqual([]);
  });

  it("picks up a swapped sidecar only after re-attaching", () => {
    const db = openQueryConnection(mdb, side);
    expect((db.prepare("SELECT v FROM side.marker").get() as any).v).toBe("old");

    const tmp = join(dir, "side.tmp");
    const s = new DatabaseSync(tmp);
    s.exec("CREATE TABLE marker(v TEXT)");
    s.exec("INSERT INTO marker VALUES('new')");
    s.close();
    renameSync(tmp, side);

    // rename() alone is invisible to an open connection: it keeps the old inode.
    expect((db.prepare("SELECT v FROM side.marker").get() as any).v).toBe("old");
    // Exercise the shipped reattachSidecar, not a hand-copy of its body, so
    // it can never silently drift from the test that claims to cover it.
    reattachSidecar(db, side);
    expect((db.prepare("SELECT v FROM side.marker").get() as any).v).toBe("new");
    db.close();
    expect(existsSync(side)).toBe(true);
  });
});

describe("hasHotJournal", () => {
  it("is false when there is no journal file", () => {
    expect(hasHotJournal(join(dir, "nonexistent.db"))).toBe(false);
  });

  it("is false when a journal file exists without the hot-journal magic", () => {
    const p = join(dir, "clean-with-journal.db");
    writeFileSync(p, "");
    // SQLite writes a zeroed placeholder header before it is sure it needs
    // to persist a page; that placeholder must never read as hot.
    writeFileSync(`${p}-journal`, Buffer.alloc(8));
    expect(hasHotJournal(p)).toBe(false);
  });

  it("is true when the journal header carries SQLite's hot-journal magic", () => {
    const p = join(dir, "synthetic-hot.db");
    writeFileSync(p, "");
    writeFileSync(`${p}-journal`, Buffer.from(HOT_JOURNAL_MAGIC + "00".repeat(16), "hex"));
    expect(hasHotJournal(p)).toBe(true);
  });

  it("is false, not thrown, when the journal cannot be read", () => {
    // A directory at the "-journal" path is a portable way to force a read
    // failure regardless of which user runs the test (unlike chmod, which a
    // root-run test would simply ignore): existsSync sees it, openSync
    // succeeds on a directory, and readSync then fails with EISDIR -- so
    // this exercises the read-time catch, not just the open-time one.
    const p = join(dir, "unreadable-journal.db");
    writeFileSync(p, "");
    mkdirSync(`${p}-journal`);
    expect(() => hasHotJournal(p)).not.toThrow();
    expect(hasHotJournal(p)).toBe(false);
  });
});

describe("hot journal recovery", () => {
  it(
    "fails with a clear explanation, not a raw SQLite error, on a journal left by a killed writer",
    async () => {
      const hotDir = mkdtempSync(join(tmpdir(), "edj-hot-"));
      const hotMdb = makeLibrary(hotDir, { tracks: 50_000 });

      // Force a real spill: cache_size = 20 is far below the dirty page
      // count for a whole-table UPDATE over 50k rows, so the child must
      // write pages — with a real journal header — to disk before it is
      // killed. A smaller table or default cache never reaches this.
      await new Promise<void>((resolve, reject) => {
        const child = fork(hotWriterScript, [hotMdb]);
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error("hot-journal-writer never signalled ready"));
        }, 15_000);
        child.on("message", () => {
          clearTimeout(timer);
          child.kill("SIGKILL");
        });
        child.on("error", (e) => { clearTimeout(timer); reject(e); });
        child.on("exit", () => resolve());
      });

      const journalPath = `${hotMdb}-journal`;
      expect(existsSync(journalPath)).toBe(true);
      const fd = openSync(journalPath, "r");
      const header = Buffer.alloc(8);
      readSync(fd, header, 0, 8, 0);
      closeSync(fd);
      expect(header.toString("hex")).toBe(HOT_JOURNAL_MAGIC);
      expect(hasHotJournal(hotMdb)).toBe(true);

      expect(() => openQueryConnection(hotMdb, null)).toThrow(/launch engine dj/i);

      rmSync(hotDir, { recursive: true, force: true });
    },
    20_000,
  );
});

describe("openSyncConnection", () => {
  it("gives a writable sidecar with a read-only engine attachment", () => {
    const own = join(dir, "own-sidecar.db");
    const sync = openSyncConnection(own, mdb);
    sync.exec("CREATE TABLE scratch(x)");
    sync.exec("INSERT INTO scratch VALUES (1)");
    expect((sync.prepare("SELECT COUNT(*) c FROM scratch").get() as any).c).toBe(1);
    expect((sync.prepare("SELECT COUNT(*) c FROM engine.Track").get() as any).c).toBe(100);
    expect(() => sync.exec("UPDATE engine.Track SET rating = 1")).toThrow(/readonly/i);
    sync.close();
  });
});

describe("ATTACH path binding", () => {
  it("opens a library whose path contains an apostrophe, a hash and a space", () => {
    const oddDir = join(dir, "Rock 'n' Roll #1 Mix");
    mkdirSync(oddDir, { recursive: true });
    const oddMdb = makeLibrary(oddDir, { tracks: 20 });
    const oddSide = join(oddDir, "side.db");
    const s = new DatabaseSync(oddSide);
    s.exec("CREATE TABLE marker(v TEXT)");
    s.close();

    // openSyncConnection: the exact case the apostrophe broke via string
    // interpolation into the ATTACH statement.
    const sync = openSyncConnection(oddSide, oddMdb);
    expect((sync.prepare("SELECT COUNT(*) c FROM engine.Track").get() as any).c).toBe(20);
    expect(() => sync.exec("UPDATE engine.Track SET rating = 1")).toThrow(/readonly/i);
    sync.close();

    // openQueryConnection's sidecar attach follows the same code path; hold
    // it to the same standard even though the odd path here is the sidecar,
    // not m.db.
    const q = openQueryConnection(oddMdb, oddSide);
    expect((q.prepare("SELECT COUNT(*) c FROM Track").get() as any).c).toBe(20);
    q.close();
  });
});
