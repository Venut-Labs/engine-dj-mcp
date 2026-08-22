import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { makeLibrary, addPlaylists } from "./gen-library.js";

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

  it("carries Engine's own playlist chain triggers, so writes behave as they do in Engine", () => {
    // The insert triggers are the entire mechanism behind appending a playlist:
    // inserting with nextListId = 0 must relink the previous tail. A fixture
    // without them would let a wrong implementation pass.
    const dir = mkdtempSync(join(tmpdir(), "gen-trig-"));
    const dbPath = makeLibrary(dir, { tracks: 3 });
    addPlaylists(dbPath, [{ id: 1, title: "First", nextListId: 0 }]);

    const db = new DatabaseSync(dbPath);
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name")
      .all()
      .map((r: any) => r.name);
    expect(names).toContain("trigger_before_insert_List");
    expect(names).toContain("trigger_after_insert_List");
    expect(names).toContain("trigger_after_delete_List");
    expect(names).toContain("trigger_before_delete_PlaylistEntity");

    // And they work: inserting a second list with nextListId = 0 must move the
    // tail marker onto it and point the old tail at it.
    const oldTail = db.prepare("SELECT id FROM Playlist WHERE nextListId = 0").get() as any;
    db.prepare(
      `INSERT INTO Playlist (title, parentListId, isPersisted, nextListId, lastEditTime, isExplicitlyExported)
       VALUES ('Second', 0, 1, 0, datetime('now'), 0)`,
    ).run();
    const newTail = db.prepare("SELECT id, title FROM Playlist WHERE nextListId = 0").get() as any;
    expect(newTail.title).toBe("Second");
    const relinked = db.prepare("SELECT nextListId FROM Playlist WHERE id = ?").get(oldTail.id) as any;
    expect(relinked.nextListId).toBe(newTail.id);

    // The arithmetic -(1 + N) must be general for N > 0, not hardcoded as -1.
    // Insert a third list pointing to the second: the trigger must compute
    // -(1 + newTail.id), not just -1, to avoid collision. The old tail (second)
    // should be relinked from first via the new third.
    const secondId = newTail.id;
    db.prepare(
      `INSERT INTO Playlist (title, parentListId, isPersisted, nextListId, lastEditTime, isExplicitlyExported)
       VALUES ('Third', 0, 1, ?, datetime('now'), 0)`,
    ).run(secondId);
    const third = db.prepare("SELECT id FROM Playlist WHERE title = 'Third'").get() as any;
    const oldTailRelinked = db.prepare("SELECT nextListId FROM Playlist WHERE id = ?").get(oldTail.id) as any;
    expect(oldTailRelinked.nextListId).toBe(third.id);

    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
