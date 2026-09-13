// tests/rating-scale.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { makeLibrary } from "./fixtures/gen-library.js";
import { readLibraryInfo } from "../src/discovery.js";
import { QueryProcess } from "../src/proc/query-client.js";
import { IndexManager } from "../src/store/index-manager.js";
import { searchTracks } from "../src/tools/search.js";
import { isEngineError } from "../src/errors.js";

/**
 * Engine stores a rating as 0, 20, 40, 60, 80 or 100 -- measured 2026-09-13:
 * four stars set in Engine came back as 80. README has always documented the
 * `rating` filter as 0-5, and the filter compares the caller's number against
 * that raw column, so `rating: { min: 4 }` matched every rated track and
 * `{ max: 3 }` matched only unrated ones.
 *
 * It went unnoticed because the fixture generator wrote ratings as 0..5: the
 * fixture and the filter shared one wrong idea of the column, and no test
 * could tell them apart.
 */
let dir: string, mdb: string, qp: QueryProcess;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "edj-rating-"));
  mdb = makeLibrary(dir, { tracks: 12 });
  const raw = new DatabaseSync(mdb);
  // One track per star level, in Engine's own units.
  const set = raw.prepare("UPDATE Track SET rating = ? WHERE id = ?");
  [0, 20, 40, 60, 80, 100].forEach((v, i) => set.run(v, i + 1));
  raw.prepare("UPDATE Track SET rating = 0 WHERE id > 6").run();
  raw.close();
  const lib = readLibraryInfo(mdb);
  if (isEngineError(lib)) throw new Error("fixture unreadable");
  qp = new QueryProcess(mdb, null, 10_000);
  await new IndexManager(lib, qp, join(dir, "sidecars")).ensureFresh();
});
afterAll(() => {
  qp.dispose();
  rmSync(dir, { recursive: true, force: true });
});

const ids = async (args: Record<string, unknown>) => {
  const r = await searchTracks(qp, { fields: ["id", "rating", "rating_stars"], limit: 50, ...args });
  if (isEngineError(r)) throw new Error(r.message);
  return r.tracks.map((t) => t.id).sort((a: any, b: any) => a - b);
};

describe("the rating filter speaks stars, as README has always said", () => {
  it("takes four stars to mean four, not the raw 4", async () => {
    // The bug: `min: 4` against the raw column matched 20, 40, 60, 80 and 100
    // -- every rated track. Four stars means 80 and 100.
    expect(await ids({ rating: { min: 4 } })).toEqual([5, 6]);
  });

  it("takes three stars and under to mean three and under, not only unrated", async () => {
    // The bug: `max: 3` against the raw column matched only rating 0.
    expect(await ids({ rating: { max: 3 } })).toEqual(
      expect.arrayContaining([1, 2, 3, 4]),
    );
    expect(await ids({ rating: { max: 3 } })).not.toContain(5);
    expect(await ids({ rating: { max: 3 } })).not.toContain(6);
  });

  it("reads a band of stars", async () => {
    expect(await ids({ rating: { min: 2, max: 3 } })).toEqual([3, 4]);
  });

  it("offers rating_stars beside the raw rating, so both languages are readable", async () => {
    const r = await searchTracks(qp, { fields: ["id", "rating", "rating_stars"], limit: 6 });
    if (isEngineError(r)) throw new Error(r.message);
    const byId = new Map(r.tracks.map((t) => [t.id, t]));
    expect(byId.get(5)).toMatchObject({ rating: 80, rating_stars: 4 });
    expect(byId.get(1)).toMatchObject({ rating: 0, rating_stars: 0 });
    expect(byId.get(6)).toMatchObject({ rating: 100, rating_stars: 5 });
  });
});

describe("a rating Engine did not write", () => {
  it("rounds to the nearest star and keeps the exact value in `rating`", async () => {
    // Engine writes multiples of 20, but the column has no CHECK and other
    // software writes to these libraries -- Database2 holds a Lexicon backup
    // folder. ID3's POPM is 0-255, so a value like 55 is reachable. It must
    // read as three stars rather than as nothing, and `rating` must still say
    // 55, which is the only place that value survives.
    const d = mkdtempSync(join(tmpdir(), "edj-rating-odd-"));
    const p = makeLibrary(d, { tracks: 4 });
    const raw = new DatabaseSync(p);
    raw.prepare("UPDATE Track SET rating = 55 WHERE id = 1").run();
    raw.close();
    const lib = readLibraryInfo(p);
    if (isEngineError(lib)) throw new Error("fixture unreadable");
    const q = new QueryProcess(p, null, 10_000);
    await new IndexManager(lib, q, join(d, "sidecars")).ensureFresh();
    const r = await searchTracks(q, { fields: ["id", "rating", "rating_stars"], limit: 4 });
    if (isEngineError(r)) throw new Error(r.message);
    expect(r.tracks.find((t) => t.id === 1)).toMatchObject({ rating: 55, rating_stars: 3 });
    q.dispose();
    rmSync(d, { recursive: true, force: true });
  });
});

describe("the fixture stores ratings the way Engine does", () => {
  it("never writes a value that is not a multiple of 20", () => {
    // The fixture is where the wrong scale lived. A generator that keeps
    // writing 0..5 would make every test above pass against data no Engine
    // library can hold.
    const d = mkdtempSync(join(tmpdir(), "edj-rating-gen-"));
    const p = makeLibrary(d, { tracks: 200 });
    const db = new DatabaseSync(`file:${p}?mode=ro`, { readOnly: true });
    const odd = db
      .prepare("SELECT COUNT(*) AS n FROM Track WHERE rating IS NOT NULL AND rating % 20 <> 0")
      .get() as { n: number };
    const spread = db.prepare("SELECT COUNT(DISTINCT rating) AS n FROM Track").get() as { n: number };
    db.close();
    expect(odd.n).toBe(0);
    // And it still spreads them, or a filter test could pass on one value.
    expect(spread.n).toBeGreaterThan(2);
    rmSync(d, { recursive: true, force: true });
  });
});
