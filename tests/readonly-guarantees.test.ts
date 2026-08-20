// tests/readonly-guarantees.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, readdirSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { makeLibrary } from "./fixtures/gen-library.js";
import { openQueryConnection } from "../src/store/connections.js";

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
    expect(() =>
      db.prepare("WITH s AS (SELECT 1 v) INSERT INTO Track(id) SELECT v FROM s").run(),
    ).toThrow();
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

  it("reads a database that still has a hot journal", () => {
    const holder = new DatabaseSync(mdb);
    holder.exec("BEGIN IMMEDIATE");
    holder.exec("UPDATE Track SET rating = 1 WHERE id < 10");
    const db = openQueryConnection(mdb, side);
    const c = (db.prepare("SELECT COUNT(*) c FROM Track").get() as any).c;
    expect(c).toBe(100);
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
    db.exec("DETACH DATABASE side");
    db.exec(`ATTACH DATABASE 'file:${side}?mode=ro' AS side`);
    expect((db.prepare("SELECT v FROM side.marker").get() as any).v).toBe("new");
    db.close();
    expect(existsSync(side)).toBe(true);
  });
});
