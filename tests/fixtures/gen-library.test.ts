import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { makeLibrary, addPlaylists, damageChain, renumberEntries, stampEditTimes, setEmptyOrigin } from "./gen-library.js";

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

  it("can damage an entry chain in each way a real library breaks", () => {
    // The writer must refuse to edit a damaged chain, and refusing is only
    // testable against a chain that is actually damaged. These three are the
    // shapes orderByChain already warns about on the read side.
    const dir = mkdtempSync(join(tmpdir(), "gen-dmg-"));
    const dbPath = makeLibrary(dir, { tracks: 5 });
    addPlaylists(dbPath, [
      {
        id: 1,
        title: "Chain",
        nextListId: 0,
        entries: [
          { id: 1, trackId: 1, next: 2 },
          { id: 2, trackId: 2, next: 3 },
          { id: 3, trackId: 3, next: 0 },
        ],
      },
    ]);

    const heads = (p: string) => {
      const db = new DatabaseSync(p, { readOnly: true });
      const rows = db.prepare("SELECT id, nextEntityId FROM PlaylistEntity WHERE listId = 1").all() as any[];
      db.close();
      const targets = new Set(rows.map((r) => r.nextEntityId));
      return rows.filter((r) => !targets.has(r.id)).length;
    };
    const dangling = (p: string) => {
      const db = new DatabaseSync(p, { readOnly: true });
      const n = db
        .prepare(
          `SELECT COUNT(*) c FROM PlaylistEntity WHERE listId = 1 AND nextEntityId <> 0
             AND nextEntityId NOT IN (SELECT id FROM PlaylistEntity WHERE listId = 1)`,
        )
        .get() as any;
      db.close();
      return n.c;
    };

    const cyc = join(dir, "cyc.db");
    copyFileSync(dbPath, cyc);
    damageChain(cyc, 1, "cycle");
    expect(heads(cyc), "cycle leaves no head").toBe(0);

    const dang = join(dir, "dang.db");
    copyFileSync(dbPath, dang);
    damageChain(dang, 1, "dangling");
    expect(dangling(dang), "dangling link").toBe(1);

    const two = join(dir, "two.db");
    copyFileSync(dbPath, two);
    damageChain(two, 1, "two-heads");
    expect(heads(two), "two disconnected runs").toBe(2);
    // Two runs that each end properly -- the severed row terminates at 0 --
    // not one run and a dangling stub. A shape that left the severed row
    // pointing somewhere would be a different damage, and the writer's
    // refusal would be tested against the wrong thing.
    const tails = (() => {
      const db = new DatabaseSync(two);
      const n = db.prepare("SELECT COUNT(*) c FROM PlaylistEntity WHERE listId = 1 AND nextEntityId = 0").get() as any;
      db.close();
      return n.c as number;
    })();
    expect(tails, "both runs end at 0").toBe(2);
    expect(dangling(two), "and nothing dangles").toBe(0);

    rmSync(dir, { recursive: true, force: true });
  });

  it("damages an already-cyclic chain further where the shape needs no tail", () => {
    // The tail used to be looked up up front for every shape, so asking for a
    // dangling link on a list that was already a cycle died with a bare
    // TypeError -- though only the cycle shape ever uses the tail.
    const d = mkdtempSync(join(tmpdir(), "dmg-"));
    const dbPath = makeLibrary(d, { tracks: 4 });
    addPlaylists(dbPath, [{ id: 1, title: "Set", nextListId: 0, entries: [
      { id: 1, trackId: 1, next: 2 }, { id: 2, trackId: 2, next: 3 }, { id: 3, trackId: 3, next: 0 },
    ] }]);
    damageChain(dbPath, 1, "cycle");
    expect(() => damageChain(dbPath, 1, "dangling")).not.toThrow();
    rmSync(d, { recursive: true, force: true });
  });

  it("says what is wrong when asked to close a cycle that has no tail left", () => {
    const d = mkdtempSync(join(tmpdir(), "dmg-"));
    const dbPath = makeLibrary(d, { tracks: 4 });
    addPlaylists(dbPath, [{ id: 1, title: "Set", nextListId: 0, entries: [
      { id: 1, trackId: 1, next: 2 }, { id: 2, trackId: 2, next: 3 }, { id: 3, trackId: 3, next: 0 },
    ] }]);
    damageChain(dbPath, 1, "cycle");
    expect(() => damageChain(dbPath, 1, "cycle")).toThrow(/no tail/);
    rmSync(d, { recursive: true, force: true });
  });

  it("refuses a list too short to damage in all three shapes", () => {
    // Two entries cannot hold a two-heads split and a distinct dangling link at
    // once, so the helper insists on three rather than quietly producing a
    // shape the caller did not ask for.
    const d = mkdtempSync(join(tmpdir(), "dmg-"));
    const dbPath = makeLibrary(d, { tracks: 4 });
    addPlaylists(dbPath, [{ id: 1, title: "Set", nextListId: 0, entries: [
      { id: 1, trackId: 1, next: 2 }, { id: 2, trackId: 2, next: 0 },
    ] }]);
    for (const kind of ["cycle", "dangling", "two-heads"] as const) {
      expect(() => damageChain(dbPath, 1, kind)).toThrow(/at least 3 entries/);
    }
    rmSync(d, { recursive: true, force: true });
  });
});

describe("renumberEntries", () => {
  it("renumbers entries into display order the way an Engine launch does", () => {
    // Measured 2026-09-01: Engine rewrote a list this server had edited to
    // 126 -> 127 -> 616 -> 128 -> 129 -> 130 -> 0 as
    // 126 -> 127 -> 128 -> 129 -> 130 -> 131 -> 0. Same tracks, same order,
    // different ids. The helper has to reproduce both halves of that: the
    // order it keeps, and the ids it does not.
    const d = mkdtempSync(join(tmpdir(), "renum-"));
    const dbPath = makeLibrary(d, { tracks: 6 });
    addPlaylists(dbPath, [
      {
        id: 1,
        title: "Set",
        nextListId: 0,
        // An entry with an out-of-line id, as an insert into the middle
        // produces: AUTOINCREMENT hands out a high number, not a neighbouring one.
        entries: [
          { id: 10, trackId: 1, next: 11 },
          { id: 11, trackId: 2, next: 616 },
          { id: 616, trackId: 3, next: 12 },
          { id: 12, trackId: 4, next: 0 },
        ],
      },
    ]);

    const db = new DatabaseSync(dbPath);
    const walk = () => {
      const rows = db
        .prepare("SELECT id, trackId, nextEntityId FROM PlaylistEntity WHERE listId = 1")
        .all() as { id: number; trackId: number; nextEntityId: number }[];
      const next = new Map(rows.map((r) => [r.id, r.nextEntityId]));
      const track = new Map(rows.map((r) => [r.id, r.trackId]));
      const pointed = new Set(rows.map((r) => r.nextEntityId));
      const head = rows.find((r) => !pointed.has(r.id))!.id;
      const ids: number[] = [];
      for (let cur = head; cur !== 0; cur = next.get(cur)!) ids.push(cur);
      return { ids, tracks: ids.map((i) => track.get(i)!) };
    };

    const before = walk();
    expect(before.ids).toEqual([10, 11, 616, 12]);
    expect(before.tracks).toEqual([1, 2, 3, 4]);

    renumberEntries(dbPath, 1);

    const after = walk();
    expect(after.tracks, "display order survives").toEqual([1, 2, 3, 4]);
    expect(after.ids, "ids become contiguous from the list's lowest").toEqual([10, 11, 12, 13]);

    // The trap this exists to encode: 12 named the last entry and now names
    // the third. An id that survives means something else afterwards, which
    // is worse than one that vanishes -- it fails silently instead of loudly.
    expect(before.ids[3], "id 12 was position 4").toBe(12);
    expect(after.ids[2], "id 12 is now position 3").toBe(12);

    db.close();
    rmSync(d, { recursive: true, force: true });
  });

  it("refuses a chain it cannot walk, rather than inventing an order", () => {
    const d = mkdtempSync(join(tmpdir(), "renum-"));
    const dbPath = makeLibrary(d, { tracks: 4 });
    addPlaylists(dbPath, [
      { id: 1, title: "Set", nextListId: 0, entries: [
        { id: 1, trackId: 1, next: 2 },
        { id: 2, trackId: 2, next: 3 },
        { id: 3, trackId: 3, next: 0 },
      ] },
    ]);
    damageChain(dbPath, 1, "two-heads");
    expect(() => renumberEntries(dbPath, 1)).toThrow(/head/);
    rmSync(d, { recursive: true, force: true });
  });
});

describe("Engine's Track triggers in the fixture", () => {
  const read = (p: string, id: number) => {
    const db = new DatabaseSync(`file:${p}?mode=ro`, { readOnly: true });
    const r = db
      .prepare("SELECT genre, lastEditTime, originDatabaseUuid AS ou, originTrackId AS ot, typeof(originTrackId) AS ott FROM Track WHERE id = ?")
      .get(id) as { genre: string; lastEditTime: number; ou: string | null; ot: number | string | null; ott: string };
    db.close();
    return r;
  };

  it("restamps lastEditTime when a tagged column changes, and not when lastEditTime itself does", () => {
    // Measured on a real library: trigger_after_update_only_Track_timestamp
    // lists genre, comment, label, year and rating among its OF columns and
    // does not list lastEditTime -- so the sentinel write below cannot fire it.
    const d = mkdtempSync(join(tmpdir(), "trg-"));
    const p = makeLibrary(d, { tracks: 3 });
    stampEditTimes(p);
    expect(read(p, 1).lastEditTime).toBe(1);

    const w = new DatabaseSync(p);
    w.prepare("UPDATE Track SET genre = 'Techno' WHERE id = 1").run();
    w.close();
    expect(read(p, 1).lastEditTime).toBeGreaterThan(1);
    expect(read(p, 2).lastEditTime).toBe(1);
    rmSync(d, { recursive: true, force: true });
  });

  it("rewrites an empty origin on any update, which is the harm the edit tool must not cause", () => {
    const d = mkdtempSync(join(tmpdir(), "trg-"));
    const p = makeLibrary(d, { tracks: 3, uuid: "fx-uuid" });
    setEmptyOrigin(p, 2, "empty-uuid");
    expect(read(p, 2).ou).toBe("");

    const w = new DatabaseSync(p);
    w.prepare("UPDATE Track SET genre = 'House' WHERE id = 2").run();
    w.close();
    expect(read(p, 2).ou).toBe("fx-uuid");
    expect(read(p, 2).ot).toBe(2);
    rmSync(d, { recursive: true, force: true });
  });

  it("leaves a TEXT '' originTrackId alone, because in SQLite '' = 0 is false", () => {
    const d = mkdtempSync(join(tmpdir(), "trg-"));
    const p = makeLibrary(d, { tracks: 3, uuid: "fx-uuid" });
    setEmptyOrigin(p, 3, "text-empty-id");
    expect(read(p, 3).ott).toBe("text");

    const w = new DatabaseSync(p);
    w.prepare("UPDATE Track SET genre = 'House' WHERE id = 3").run();
    w.close();
    expect(read(p, 3).ott).toBe("text");
    rmSync(d, { recursive: true, force: true });
  });

  it("keeps every empty-origin shape in place, even across stampEditTimes", () => {
    const d = mkdtempSync(join(tmpdir(), "trg-"));
    const p = makeLibrary(d, { tracks: 4 });
    setEmptyOrigin(p, 1, "null-id");
    setEmptyOrigin(p, 2, "zero-id");
    setEmptyOrigin(p, 3, "empty-uuid");
    stampEditTimes(p);
    expect(read(p, 1).ot).toBeNull();
    expect(read(p, 2).ot).toBe(0);
    expect(read(p, 3).ou).toBe("");
    rmSync(d, { recursive: true, force: true });
  });
});
