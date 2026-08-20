import { describe, it, expect } from "vitest";
import { checkStatement, enforceLimit } from "../src/guard.js";

describe("statement guard", () => {
  it("allows basic SELECT statements", () => {
    for (const sql of ["SELECT 1", "select * from Track", "SELECT * FROM Track limit 5"]) {
      expect(checkStatement(sql)).toBeNull();
    }
  });

  it("allows WITH (CTE) statements", () => {
    expect(checkStatement("WITH x AS (SELECT 1) SELECT * FROM x")).toBeNull();
  });

  it("allows read-only PRAGMA introspection", () => {
    for (const sql of [
      "PRAGMA table_info('Track')",
      "PRAGMA table_list",
      "pragma table_list",
      "PRAGMA index_list('Track')",
      "PRAGMA index_info('idx_name')",
      "PRAGMA foreign_key_list('Track')",
      "PRAGMA main.table_info('Track')",
      "PRAGMA temp.table_list",
      "PRAGMA side.index_info('idx')",
    ]) {
      expect(checkStatement(sql)).toBeNull();
    }
  });

  it("allows EXPLAIN QUERY PLAN", () => {
    expect(checkStatement("EXPLAIN QUERY PLAN SELECT 1")).toBeNull();
  });

  it("allows trailing semicolon and trailing comments", () => {
    for (const sql of ["SELECT 1;", "SELECT 1; -- trailing note", "SELECT 1; /* comment */"]) {
      expect(checkStatement(sql)).toBeNull();
    }
  });

  it("allows semicolons and VACUUM inside string literals", () => {
    for (const sql of ["SELECT ';' AS x", "SELECT 'a;b'", "SELECT 'VACUUM INTO' AS text"]) {
      expect(checkStatement(sql)).toBeNull();
    }
  });

  it("rejects VACUUM, ATTACH, DETACH statements", () => {
    for (const sql of [
      "VACUUM",
      "VACUUM INTO '/tmp/exfil.db'",
      "ATTACH DATABASE '/tmp/x.db' AS rw",
      "DETACH DATABASE side",
    ]) {
      const e = checkStatement(sql);
      expect(e?.error).toBe("invalid_argument");
    }
  });

  it("rejects VACUUM/ATTACH/DETACH hidden by comments", () => {
    for (const sql of [
      "-- harmless\nVACUUM INTO '/tmp/exfil.db'",
      "/* comment */ VACUUM INTO '/tmp/exfil.db'",
      "-- comment\nATTACH DATABASE '/tmp/x.db' AS rw",
      "/* c */ DETACH DATABASE side",
    ]) {
      const e = checkStatement(sql);
      expect(e?.error).toBe("invalid_argument");
    }
  });

  it("rejects VACUUM/ATTACH/DETACH with unusual spacing and case", () => {
    for (const sql of [
      "VaCuUm   InTo '/tmp/x.db'",
      "vacuum\nINTO '/tmp/exfil.db'",
      "ATTACH\n  DATABASE '/tmp/x.db' AS rw",
    ]) {
      const e = checkStatement(sql);
      expect(e?.error).toBe("invalid_argument");
    }
  });

  it("rejects write-mode PRAGMA statements", () => {
    for (const sql of ["PRAGMA journal_mode = WAL", "PRAGMA cache_size = 2000", "PRAGMA synchronous = OFF"]) {
      const e = checkStatement(sql);
      expect(e?.error).toBe("invalid_argument");
    }
  });

  it("rejects PRAGMA names that look similar but are not permitted", () => {
    for (const sql of ["PRAGMA table_infoX", "PRAGMA table_info_extra('Track')", "PRAGMA index_listX"]) {
      const e = checkStatement(sql);
      expect(e?.error).toBe("invalid_argument");
    }
  });

  it("rejects chained statements", () => {
    for (const sql of [
      "SELECT 1; VACUUM INTO '/tmp/x.db'",
      "SELECT 1; SELECT 2",
      "SELECT 1; DELETE FROM Track",
    ]) {
      const e = checkStatement(sql);
      expect(e?.error).toBe("invalid_argument");
    }
  });

  it("adds LIMIT when the query has none", () => {
    expect(enforceLimit("SELECT * FROM Track", 50)).toBe("SELECT * FROM Track LIMIT 50");
    expect(enforceLimit("SELECT * FROM Track WHERE 1 = 1", 50)).toBe("SELECT * FROM Track WHERE 1 = 1 LIMIT 50");
  });

  it("preserves existing LIMIT clauses", () => {
    expect(enforceLimit("SELECT * FROM Track LIMIT 10", 50)).toBe("SELECT * FROM Track LIMIT 10");
    expect(enforceLimit("SELECT * FROM Track LIMIT 100", 50)).toBe("SELECT * FROM Track LIMIT 100");
  });

  it("appends LIMIT even when LIMIT appears in a string literal", () => {
    expect(enforceLimit("SELECT * FROM Track WHERE title = 'limit break'", 50)).toBe(
      "SELECT * FROM Track WHERE title = 'limit break' LIMIT 50"
    );
  });

  it("handles WITH statements for enforceLimit", () => {
    expect(enforceLimit("WITH x AS (SELECT 1) SELECT * FROM x", 50)).toBe(
      "WITH x AS (SELECT 1) SELECT * FROM x LIMIT 50"
    );
    expect(enforceLimit("WITH x AS (SELECT 1) SELECT * FROM x LIMIT 10", 50)).toBe(
      "WITH x AS (SELECT 1) SELECT * FROM x LIMIT 10"
    );
  });

  it("does not modify PRAGMA statements with enforceLimit", () => {
    expect(enforceLimit("PRAGMA table_info('Track')", 50)).toBe("PRAGMA table_info('Track')");
    expect(enforceLimit("PRAGMA table_list", 50)).toBe("PRAGMA table_list");
  });

  it("does not modify other statement types with enforceLimit", () => {
    expect(enforceLimit("EXPLAIN QUERY PLAN SELECT 1", 50)).toBe("EXPLAIN QUERY PLAN SELECT 1");
  });

  it("handles trailing semicolons in enforceLimit", () => {
    expect(enforceLimit("SELECT * FROM Track;", 50)).toBe("SELECT * FROM Track LIMIT 50");
    expect(enforceLimit("SELECT * FROM Track LIMIT 10;", 50)).toBe("SELECT * FROM Track LIMIT 10;");
  });
});
