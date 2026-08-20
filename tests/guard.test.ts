import { describe, it, expect } from "vitest";
import { checkStatement, enforceLimit } from "../src/guard.js";

describe("statement guard", () => {
  it("allows reads and read-only introspection", () => {
    for (const sql of [
      "SELECT 1",
      "  select * from Track limit 5",
      "WITH x AS (SELECT 1) SELECT * FROM x",
      "PRAGMA table_info('Track')",
      "EXPLAIN QUERY PLAN SELECT 1",
    ]) {
      expect(checkStatement(sql)).toBeNull();
    }
  });

  it("rejects the statements that reach the filesystem or the attach list", () => {
    for (const sql of [
      "VACUUM",
      "VACUUM INTO '/tmp/exfil.db'",
      "ATTACH DATABASE '/tmp/x.db' AS rw",
      "DETACH DATABASE side",
      "PRAGMA journal_mode = WAL",
    ]) {
      const e = checkStatement(sql);
      expect(e?.error).toBe("invalid_argument");
    }
  });

  it("rejects a leading no-op used to smuggle a second statement", () => {
    // Only meaningful because run_sql uses prepare(); exec() would run both.
    expect(checkStatement("SELECT 1; VACUUM INTO '/tmp/x.db'")?.error).toBe("invalid_argument");
  });

  it("adds a LIMIT when the query has none", () => {
    expect(enforceLimit("SELECT * FROM Track", 50)).toBe("SELECT * FROM Track LIMIT 50");
    expect(enforceLimit("SELECT * FROM Track LIMIT 10", 50)).toBe("SELECT * FROM Track LIMIT 10");
  });
});
