import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { makeLibrary } from "./gen-library.js";

let dir: string;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "edj-")); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

describe("synthetic library", () => {
  it("produces a schema 3.0.2 database with the real Track shape", () => {
    const db = new DatabaseSync(makeLibrary(dir, { tracks: 500 }), { readOnly: true });
    const info = db.prepare(
      "SELECT schemaVersionMajor a, schemaVersionMinor b, schemaVersionPatch c, uuid FROM Information",
    ).get() as any;
    expect([info.a, info.b, info.c]).toEqual([3, 0, 2]);
    expect(typeof info.uuid).toBe("string");

    const cols = (db.prepare("SELECT name FROM pragma_table_info('Track')").all() as any[])
      .map((r) => r.name);
    for (const c of ["bpmAnalyzed", "key", "timeLastPlayed", "lastEditTime", "originDatabaseUuid"]) {
      expect(cols).toContain(c);
    }
    expect((db.prepare("SELECT COUNT(*) c FROM Track").get() as any).c).toBe(500);
    expect((db.prepare("SELECT COUNT(*) c FROM PerformanceData").get() as any).c).toBe(500);
    db.close();
  });
});
