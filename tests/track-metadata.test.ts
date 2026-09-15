// tests/track-metadata.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { makeLibrary, stampEditTimes, setEmptyOrigin } from "./fixtures/gen-library.js";
import { updateTrackMetadata } from "../src/store/track-metadata.js";
import { resetSessionSnapshots } from "../src/store/write.js";
import { isEngineError } from "../src/errors.js";

const hotWriterScript = fileURLToPath(new URL("./fixtures/hot-journal-writer.js", import.meta.url));
const UUID = "meta-uuid";
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  resetSessionSnapshots();
});

/** Tracks 1-4 with known tags, every lastEditTime at the sentinel 1. */
function setup(tracks = 8) {
  const dir = mkdtempSync(join(tmpdir(), "tm-"));
  dirs.push(dir);
  const dbPath = makeLibrary(dir, { tracks, uuid: UUID });
  const w = new DatabaseSync(dbPath);
  const set = w.prepare("UPDATE Track SET genre = ?, comment = ?, label = ?, year = ?, rating = ? WHERE id = ?");
  set.run("Techno", "https://t.me/LosslessRobot", null, 2020, 0, 1);
  set.run("Électronique", null, "Label A", 2019, 80, 2);
  set.run("House", "old note", null, 0, 20, 3);
  set.run("Minimal", null, null, 2021, 0, 4);
  w.close();
  stampEditTimes(dbPath);
  return { dir, dbPath, backupDir: join(dir, "backups") };
}

function read(dbPath: string, id: number) {
  const db = new DatabaseSync(`file:${dbPath}?mode=ro`, { readOnly: true });
  const r = db
    .prepare(
      `SELECT genre, comment, label, year, rating, lastEditTime, typeof(comment) AS comment_t,
              originDatabaseUuid AS ou, originTrackId AS ot FROM Track WHERE id = ?`,
    )
    .get(id) as any;
  db.close();
  return r;
}

const ok = (r: unknown) => {
  if (isEngineError(r)) throw new Error(`refused: ${r.error} ${r.message}`);
  return r as any;
};

describe("updateTrackMetadata", () => {
  it("edits every field, touches only the rows it edits, and reports what changed", async () => {
    const { dbPath, backupDir } = setup();
    const r = ok(
      await updateTrackMetadata(dbPath, UUID, {
        updates: [{ id: 1, genre: "House", comment: "sick", label: "Drumcode", year: 2024, rating_stars: 5 }],
      }, { backupDir }),
    );
    expect(read(dbPath, 1)).toMatchObject({ genre: "House", comment: "sick", label: "Drumcode", year: 2024, rating: 100 });
    expect(read(dbPath, 1).lastEditTime).toBeGreaterThan(1);
    expect(read(dbPath, 2).lastEditTime).toBe(1);
    expect(r).toMatchObject({ updated: 1, unchanged: 0, undo_complete: true });
    expect(r.changed).toEqual([{ id: 1, fields: ["genre", "comment", "label", "year", "rating"] }]);
    expect(r.library).toEqual({ uuid: UUID, path: dbPath });
    expect(typeof r.backup_path).toBe("string");
    expect(r.undo[0].arguments.library).toBe(dbPath);
  });

  it("writes an empty string as NULL", async () => {
    const { dbPath, backupDir } = setup();
    ok(await updateTrackMetadata(dbPath, UUID, { updates: [{ id: 3, comment: "" }] }, { backupDir }));
    expect(read(dbPath, 3).comment_t).toBe("null");
  });

  it("answers a call with nothing to change without a transaction, a snapshot or a timestamp", async () => {
    // Spec §5.5. withWriteTransaction is not called, so library is filled by
    // hand here -- this test is what proves it was.
    const { dbPath, backupDir } = setup();
    const r = ok(
      await updateTrackMetadata(dbPath, UUID, { updates: [{ id: 1, genre: "Techno", year: 2020 }] }, { backupDir }),
    );
    expect(r).toEqual({
      updated: 0, unchanged: 1, changed: [], undo: [], undo_complete: true,
      library: { uuid: UUID, path: dbPath },
    });
    expect(existsSync(backupDir)).toBe(false);
    expect(read(dbPath, 1).lastEditTime).toBe(1);
  });

  it("round-trips through its own undo", async () => {
    const { dbPath, backupDir } = setup();
    const before = read(dbPath, 2);
    const r = ok(
      await updateTrackMetadata(dbPath, UUID, {
        updates: [{ id: 2, genre: "Electronic", comment: "note", label: "", year: 2024, rating_stars: 2 }],
      }, { backupDir }),
    );
    const step = r.undo[0];
    expect(step.tool).toBe("update_track_metadata");
    ok(await updateTrackMetadata(dbPath, UUID, { updates: step.arguments.updates }, { backupDir }));
    const after = read(dbPath, 2);
    for (const k of ["genre", "comment", "label", "year", "rating"]) expect(after[k], k).toEqual(before[k]);
  });

  it("puts back values it would never have written itself", async () => {
    // Spec §5.3: a kept-back restore path is what keeps undo_complete true.
    const { dbPath, backupDir } = setup();
    const w = new DatabaseSync(dbPath);
    w.prepare("UPDATE Track SET year = 20240905, comment = ?, rating = 196 WHERE id = 4").run("x".repeat(1500));
    w.close();
    const r = ok(
      await updateTrackMetadata(dbPath, UUID, { updates: [{ id: 4, year: 2024, comment: "short", rating_stars: 3 }] }, { backupDir }),
    );
    ok(await updateTrackMetadata(dbPath, UUID, { updates: r.undo[0].arguments.updates }, { backupDir }));
    expect(read(dbPath, 4)).toMatchObject({ year: 20240905, comment: "x".repeat(1500), rating: 196 });
  });

  it("replays an undo whose one field was already put back by hand, and still restores the rest", async () => {
    // Spec §5.2 (field-level, Ruling R7): expect guards writes, so a stale
    // expect on a field this row will not write must not refuse the fields
    // that still need restoring.
    const { dbPath, backupDir } = setup();
    const r = ok(
      await updateTrackMetadata(dbPath, UUID, { updates: [{ id: 1, genre: "House", comment: "new" }] }, { backupDir }),
    );
    const w = new DatabaseSync(dbPath);
    w.prepare("UPDATE Track SET genre = 'Techno' WHERE id = 1").run();
    w.close();
    ok(await updateTrackMetadata(dbPath, UUID, { updates: r.undo[0].arguments.updates }, { backupDir }));
    expect(read(dbPath, 1)).toMatchObject({ genre: "Techno", comment: "https://t.me/LosslessRobot" });
  });

  it("refuses to edit a field holding a value it could not put back, and edits the rest", async () => {
    const { dbPath, backupDir } = setup();
    const w = new DatabaseSync(dbPath);
    w.prepare("UPDATE Track SET rating = 55.5 WHERE id = 1").run();
    w.prepare("UPDATE Track SET rating = 999 WHERE id = 2").run();
    w.prepare("UPDATE Track SET year = '2024-09-05' WHERE id = 3").run();
    w.close();
    for (const u of [{ id: 1, rating_stars: 3 }, { id: 2, rating_stars: 0 }, { id: 3, year: 2024 }]) {
      const e = await updateTrackMetadata(dbPath, UUID, { updates: [u] }, { backupDir });
      expect((e as any).error, JSON.stringify(u)).toBe("track_not_editable");
    }
    ok(await updateTrackMetadata(dbPath, UUID, { updates: [{ id: 1, genre: "Acid" }] }, { backupDir }));
    expect(read(dbPath, 1).genre).toBe("Acid");
  });

  it("refuses a track with an empty origin and leaves that origin exactly as it was", async () => {
    // Without the refusal, Engine's trigger would rewrite the origin here --
    // tests/fixtures/gen-library.test.ts shows it doing so.
    const { dbPath, backupDir } = setup();
    setEmptyOrigin(dbPath, 2, "empty-uuid");
    const e = await updateTrackMetadata(dbPath, UUID, { updates: [{ id: 2, genre: "House" }] }, { backupDir });
    expect((e as any).error).toBe("track_not_editable");
    expect((e as any).detail).toBe("not_committed");
    expect(read(dbPath, 2)).toMatchObject({ ou: "", genre: "Électronique" });
  });

  it("edits a track whose originTrackId is TEXT '', which the trigger does not treat as empty", async () => {
    const { dbPath, backupDir } = setup();
    setEmptyOrigin(dbPath, 3, "text-empty-id");
    ok(await updateTrackMetadata(dbPath, UUID, { updates: [{ id: 3, genre: "Acid" }] }, { backupDir }));
    expect(read(dbPath, 3)).toMatchObject({ genre: "Acid", ot: "" });
  });

  it("refuses before taking a snapshot when it can tell early", async () => {
    const { dbPath, backupDir } = setup();
    const e = await updateTrackMetadata(dbPath, UUID, { updates: [{ id: 999, genre: "x" }] }, { backupDir });
    expect((e as any).error).toBe("unknown_track");
    expect(existsSync(backupDir)).toBe(false);
  });

  it("refuses a library with a hot journal, without touching it", async () => {
    const { dbPath, backupDir } = setup(3000);
    await new Promise<void>((resolve, reject) => {
      const child = fork(hotWriterScript, [dbPath]);
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("hot-journal-writer never signalled ready"));
      }, 15_000);
      child.on("message", () => { clearTimeout(timer); child.kill("SIGKILL"); });
      child.on("error", (e) => { clearTimeout(timer); reject(e); });
      child.on("exit", () => resolve());
    });
    const e = await updateTrackMetadata(dbPath, UUID, { updates: [{ id: 1, genre: "x" }] }, { backupDir });
    expect((e as any).error).toBe("library_needs_recovery");
    expect((e as any).detail).toBe("not_committed");
    expect(existsSync(backupDir)).toBe(false);
  });
});

describe("updateTrackMetadata re-reads under the lock", () => {
  // Between the read-only pre-check and BEGIN IMMEDIATE the whole database is
  // copied for the session snapshot -- long enough for Engine DJ to change a
  // row. beforeLock plays Engine: it writes on its own connection inside that
  // window.
  const engineWrites = (dbPath: string, sql: string, ...params: (string | number)[]) => () => {
    const other = new DatabaseSync(dbPath);
    other.prepare(sql).run(...params);
    other.close();
  };

  it("counts a row that reached its target meanwhile as unchanged", async () => {
    const { dbPath, backupDir } = setup();
    const r = ok(
      await updateTrackMetadata(dbPath, UUID, { updates: [{ id: 1, genre: "House" }] }, {
        backupDir,
        beforeLock: engineWrites(dbPath, "UPDATE Track SET genre = 'House' WHERE id = 1"),
      }),
    );
    expect(r).toMatchObject({ updated: 0, unchanged: 1, changed: [], undo: [] });
    expect(typeof r.backup_path).toBe("string");
  });

  it("refuses when an expect stopped matching meanwhile, keeping the other writer's value", async () => {
    const { dbPath, backupDir } = setup();
    const e = await updateTrackMetadata(
      dbPath, UUID,
      { updates: [{ id: 1, genre: "House", expect: { genre: "Techno" } }] },
      { backupDir, beforeLock: engineWrites(dbPath, "UPDATE Track SET genre = 'Deep House' WHERE id = 1") },
    );
    expect((e as any).error).toBe("stale_value");
    expect(read(dbPath, 1).genre).toBe("Deep House");
  });

  it("builds the undo from what was there under the lock, not from the pre-check", async () => {
    // Otherwise the undo would put back "Techno" and erase the DJ's edit.
    const { dbPath, backupDir } = setup();
    const r = ok(
      await updateTrackMetadata(dbPath, UUID, { updates: [{ id: 1, genre: "House" }] }, {
        backupDir,
        beforeLock: engineWrites(dbPath, "UPDATE Track SET genre = 'Deep House' WHERE id = 1"),
      }),
    );
    expect(r.undo[0].arguments.updates).toEqual([{ id: 1, genre: "Deep House", expect: { genre: "House" } }]);
  });

  it("refuses a track whose origin emptied meanwhile", async () => {
    const { dbPath, backupDir } = setup();
    const e = await updateTrackMetadata(dbPath, UUID, { updates: [{ id: 2, genre: "House" }] }, {
      backupDir,
      beforeLock: () => setEmptyOrigin(dbPath, 2, "zero-id"),
    });
    expect((e as any).error).toBe("track_not_editable");
    expect(read(dbPath, 2).ot).toBe(0);
  });
});

describe("updateTrackMetadata leaves alone what it was not asked to change", () => {
  it("updates only the named field, not the other four tag columns", async () => {
    const { dbPath, backupDir } = setup();
    ok(await updateTrackMetadata(dbPath, UUID, { updates: [{ id: 3, genre: "Acid" }] }, { backupDir }));
    expect(read(dbPath, 3)).toMatchObject({ genre: "Acid", comment: "old note", label: null, year: 0, rating: 20 });
  });

  it("does not touch a row whose only named field is already at its target", async () => {
    const { dbPath, backupDir } = setup();
    const r = ok(
      await updateTrackMetadata(dbPath, UUID, {
        updates: [{ id: 1, genre: "House" }, { id: 4, genre: "Minimal" }],
      }, { backupDir }),
    );
    expect(r).toMatchObject({ updated: 1, unchanged: 1, changed: [{ id: 1, fields: ["genre"] }] });
    expect(read(dbPath, 4).lastEditTime).toBe(1);
    expect(read(dbPath, 1).lastEditTime).toBeGreaterThan(1);
  });
});

describe("the packed-track flag", () => {
  const flag = (dbPath: string, id: number) => {
    const db = new DatabaseSync(`file:${dbPath}?mode=ro`, { readOnly: true });
    const v = (db.prepare("SELECT isMetadataOfPackedTrackChanged AS f FROM Track WHERE id = ?").get(id) as any).f;
    db.close();
    return v;
  };

  it("is set on every track this call writes, as Engine sets it on its own tag edits", async () => {
    // Measured on the date recorded in spec §3.9: a comment edit in Engine DJ on the computer's collection
    // set isMetadataOfPackedTrackChanged = 1 (spec §3.9). Without it an
    // explicit sync would not know to carry this edit to the drive.
    const { dbPath, backupDir } = setup();
    const w = new DatabaseSync(dbPath);
    w.exec("UPDATE Track SET isMetadataOfPackedTrackChanged = 0");
    w.close();
    ok(await updateTrackMetadata(dbPath, UUID, { updates: [{ id: 1, genre: "House" }, { id: 4, genre: "Minimal" }] }, { backupDir }));
    expect(flag(dbPath, 1)).toBe(1);
    expect(flag(dbPath, 4), "unchanged track, not written").toBe(0);
  });
});
