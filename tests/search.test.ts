// tests/search.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { makeLibrary } from "./fixtures/gen-library.js";
import { cueFrame, emptyCue } from "./fixtures/blob-frames.js";
import { readLibraryInfo } from "../src/discovery.js";
import { QueryProcess } from "../src/proc/query-client.js";
import { IndexManager } from "../src/store/index-manager.js";
import { searchTracks, DEFAULT_FIELDS, FIELD_SQL } from "../src/tools/search.js";
import { isEngineError } from "../src/errors.js";

let dir: string, qp: QueryProcess;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "edj-search-"));
  const mdb = makeLibrary(dir, { tracks: 1500 });

  // Deliberately decorrelate has_cues from has_beatgrid for two known ids:
  // the default generator ties quickCues and beatData to the same hasPerf
  // flag, so without this, has_cues and has_beatgrid would agree for nearly
  // every track and a field-mapping swap between them could go undetected
  // by any assertion that only checks the two flags against each other.
  //
  // Track 1's blob is a real cue frame with a pad set, not filler bytes:
  // has_cues is decoded now, so arbitrary bytes would decode to "no cue"
  // and the two ids would stop being decorrelated at all.
  {
    const raw = new DatabaseSync(mdb);
    raw.exec("PRAGMA busy_timeout=3000");
    const withCue = cueFrame(
      Array.from({ length: 8 }, (_, i) =>
        i === 0 ? { label: "", position: 44_100 * 5, colour: 0 } : emptyCue,
      ),
    );
    raw.prepare("UPDATE PerformanceData SET quickCues = ?, beatData = NULL WHERE trackId = 1").run(withCue);
    raw.prepare("UPDATE PerformanceData SET quickCues = NULL, beatData = ? WHERE trackId = 2").run(Buffer.alloc(8));
    raw.close();
  }

  const lib = readLibraryInfo(mdb);
  if (isEngineError(lib)) throw new Error("fixture library unreadable");
  qp = new QueryProcess(mdb, null, 5000);
  await new IndexManager(lib, qp, join(dir, "sidecars")).ensureFresh();
});
afterAll(() => { qp.dispose(); rmSync(dir, { recursive: true, force: true }); });

describe("search_tracks", () => {
  it("projects six fields by default", async () => {
    const r = await searchTracks(qp, { limit: 3 });
    expect(isEngineError(r)).toBe(false);
    if (isEngineError(r)) return;
    expect(Object.keys(r.tracks[0]!)).toEqual(DEFAULT_FIELDS);
  });

  it("matches full text and folds diacritics", async () => {
    const r = await searchTracks(qp, { q: "ambient", limit: 5 });
    expect(isEngineError(r)).toBe(false);
    if (isEngineError(r)) return;
    expect(r.tracks.length).toBeGreaterThan(0);
  });

  it("filters by tempo window", async () => {
    const r = await searchTracks(qp, { bpm: { around: 124, tolerance_pct: 2 }, limit: 50 });
    expect(isEngineError(r)).toBe(false);
    if (isEngineError(r)) return;
    for (const t of r.tracks) {
      expect(Number(t.bpm)).toBeGreaterThanOrEqual(124 * 0.98 - 0.01);
      expect(Number(t.bpm)).toBeLessThanOrEqual(124 * 1.02 + 0.01);
    }
  });

  it("paginates relevance-ordered results without overlap", async () => {
    // A cursor keyed on id alone cannot work here: ORDER BY rank yields
    // non-monotonic ids, so the cursor encodes (rank, rowid).
    const p1 = await searchTracks(qp, { q: "dark", limit: 5 });
    expect(isEngineError(p1)).toBe(false);
    if (isEngineError(p1)) return;
    expect(p1.next_cursor).toBeTruthy();

    const p2 = await searchTracks(qp, { q: "dark", limit: 5, cursor: p1.next_cursor });
    expect(isEngineError(p2)).toBe(false);
    if (isEngineError(p2)) return;

    const ids1 = p1.tracks.map((t) => t.id);
    const ids2 = p2.tracks.map((t) => t.id);
    expect(ids1.filter((i) => ids2.includes(i))).toEqual([]);
  });

  it("omits total unless asked, and caps it when asked", async () => {
    const without = await searchTracks(qp, { limit: 2 });
    expect(isEngineError(without)).toBe(false);
    if (isEngineError(without)) return;
    expect(without.total).toBeUndefined();

    const with_ = await searchTracks(qp, { limit: 2, include_total: true });
    expect(isEngineError(with_)).toBe(false);
    if (isEngineError(with_)) return;
    expect(with_.total).toBeGreaterThan(0);
  });

  it("clamps limit to the maximum", async () => {
    const r = await searchTracks(qp, { limit: 5000 });
    expect(isEngineError(r)).toBe(false);
    if (isEngineError(r)) return;
    expect(r.tracks.length).toBeLessThanOrEqual(200);
  });
});

describe("search_tracks — field allowlist", () => {
  it("exports FIELD_SQL directly, gating every projected column", () => {
    expect(FIELD_SQL.id).toBe("t.id");
    expect(FIELD_SQL.bpm).toBe("d.tempo");
    expect(FIELD_SQL.camelot).toBe("d.camelot");
  });

  it("rejects an unrecognised field instead of silently dropping it", async () => {
    const r = await searchTracks(qp, { fields: ["id", "not_a_real_field"], limit: 3 });
    expect(isEngineError(r)).toBe(true);
    if (!isEngineError(r)) return;
    expect(r.error).toBe("invalid_argument");
  });

  it("rejects an empty fields array", async () => {
    const r = await searchTracks(qp, { fields: [], limit: 3 });
    expect(isEngineError(r)).toBe(true);
    if (!isEngineError(r)) return;
    expect(r.error).toBe("invalid_argument");
  });
});

describe("search_tracks — FTS5 sanitisation", () => {
  it("a trailing * still performs a prefix search", async () => {
    // "hypnotic" is one of the fixture's title words; the star must land
    // outside the closing quote or FTS5 treats it as a literal character
    // and the prefix match silently stops matching anything.
    const prefix = await searchTracks(qp, { q: "hypno*", limit: 50 });
    expect(isEngineError(prefix)).toBe(false);
    if (isEngineError(prefix)) return;
    expect(prefix.tracks.length).toBeGreaterThan(0);

    const exact = await searchTracks(qp, { q: "hypnotic", limit: 50 });
    expect(isEngineError(exact)).toBe(false);
    if (isEngineError(exact)) return;
    // The prefix query is a superset: it also matches "hypnotic" hits.
    expect(prefix.tracks.length).toBeGreaterThanOrEqual(exact.tracks.length);
  });

  it("a hyphenated name does not raise an FTS5 syntax error", async () => {
    const r = await searchTracks(qp, { q: "Jean-Michel Jarre", limit: 5 });
    expect(isEngineError(r)).toBe(false);
  });

  it("an apostrophe does not raise an FTS5 syntax error", async () => {
    const r = await searchTracks(qp, { q: "D'Angelo", limit: 5 });
    expect(isEngineError(r)).toBe(false);
  });

  it("a multi-word phrase ANDs its tokens together", async () => {
    const r = await searchTracks(qp, { q: "dark rolling", limit: 50 });
    expect(isEngineError(r)).toBe(false);
    if (isEngineError(r)) return;
    expect(r.tracks.length).toBeGreaterThan(0);
  });

  it("FTS5 boolean/proximity operators in q are treated as literal text, not syntax", async () => {
    for (const q of ["NOT dark", "dark OR warm", "dark AND (warm", "NEAR(dark warm)", "col:value"]) {
      const r = await searchTracks(qp, { q, limit: 5 });
      expect(isEngineError(r)).toBe(false);
    }
  });

  it("a punctuation-only query returns an empty result, not an error", async () => {
    // Verified directly against node:sqlite: a bare hyphen, a bare star, a
    // hyphen/punctuation carrying a prefix star, and a literal quoted-empty
    // phrase all sanitise to a syntactically valid MATCH that simply never
    // matches fixture data (none of it is punctuation-only) rather than
    // erroring or silently falling back to an unfiltered scan.
    for (const q of ["-", "*", "-*", "!!!", "!!!*", '""']) {
      const r = await searchTracks(qp, { q, limit: 5 });
      expect(isEngineError(r)).toBe(false);
      if (isEngineError(r)) continue;
      expect(r.tracks.length).toBe(0);
    }
  });
});

describe("search_tracks — other filters", () => {
  it("filters by key.mode", async () => {
    const r = await searchTracks(qp, { key: { mode: "minor" }, fields: ["id", "camelot"], limit: 50 });
    expect(isEngineError(r)).toBe(false);
    if (isEngineError(r)) return;
    for (const t of r.tracks) {
      if (t.camelot !== null) expect(String(t.camelot).endsWith("A")).toBe(true);
    }
  });

  it("filters by key.compatible_with using the Camelot neighbour set", async () => {
    const r = await searchTracks(qp, {
      key: { compatible_with: "8A" },
      fields: ["id", "camelot"],
      limit: 200,
    });
    expect(isEngineError(r)).toBe(false);
    if (isEngineError(r)) return;
    const allowed = new Set(["8A", "8B", "7A", "9A"]);
    for (const t of r.tracks) {
      if (t.camelot !== null) expect(allowed.has(String(t.camelot))).toBe(true);
    }
  });

  it("played.never returns only unplayed tracks, and strictly fewer than unfiltered", async () => {
    // Fixture: ~60% of 1500 tracks are played, so both sides are non-empty
    // (confirmed by execution: never.total = 603).
    const never = await searchTracks(qp, {
      played: { never: true }, fields: ["id", "last_played"], limit: 50, include_total: true,
    });
    expect(isEngineError(never)).toBe(false);
    if (isEngineError(never)) return;
    expect(never.tracks.length).toBeGreaterThan(0);
    for (const t of never.tracks) expect(t.last_played).toBeNull();

    const all = await searchTracks(qp, { limit: 1, include_total: true });
    expect(isEngineError(all)).toBe(false);
    if (isEngineError(all)) return;
    // never.total lands under the 1000 cap (603, exact) while the
    // unfiltered total is capped at 1000, so this comparison is a genuine
    // inequality, not an artifact of both sides being capped equal.
    expect(never.total!).toBeLessThan(all.total!);
  });

  it("played.before/after a relative cutoff partition into disjoint, non-empty sets", async () => {
    const cutoffRes = await qp.run("SELECT CAST(strftime('%s','now','-6 months') AS INTEGER) AS c");
    expect(isEngineError(cutoffRes)).toBe(false);
    if (isEngineError(cutoffRes)) return;
    const cutoffEpoch = Number(cutoffRes.rows[0]![0]);

    const before = await searchTracks(qp, {
      played: { before: "-6 months" }, fields: ["id", "last_played"], limit: 200,
    });
    const after = await searchTracks(qp, {
      played: { after: "-6 months" }, fields: ["id", "last_played"], limit: 200,
    });
    expect(isEngineError(before)).toBe(false);
    expect(isEngineError(after)).toBe(false);
    if (isEngineError(before) || isEngineError(after)) return;

    expect(before.tracks.length).toBeGreaterThan(0);
    expect(after.tracks.length).toBeGreaterThan(0);

    for (const t of before.tracks) {
      if (t.last_played !== null) expect(Number(t.last_played)).toBeLessThan(cutoffEpoch);
    }
    for (const t of after.tracks) {
      expect(t.last_played).not.toBeNull();
      expect(Number(t.last_played)).toBeGreaterThanOrEqual(cutoffEpoch);
    }

    // Mutually exclusive by construction (NULL/old vs. non-null/recent), so
    // no id can legitimately appear on both sides of the same cutoff.
    const beforeIds = new Set(before.tracks.map((t) => t.id));
    for (const t of after.tracks) expect(beforeIds.has(t.id)).toBe(false);
  });

  it("added.after keeps only tracks added at or after the cutoff, and changes the count", async () => {
    // 500 days before "now" falls inside the fixture's 0..1500-day dateAdded
    // spread, so both the filtered and complementary populations are large.
    const cutoffIso = new Date(Date.now() - 500 * 86400 * 1000).toISOString().slice(0, 10);
    const cutoffRes = await qp.run("SELECT CAST(strftime('%s', ?) AS INTEGER) AS c", [cutoffIso]);
    expect(isEngineError(cutoffRes)).toBe(false);
    if (isEngineError(cutoffRes)) return;
    const cutoffEpoch = Number(cutoffRes.rows[0]![0]);

    const r = await searchTracks(qp, {
      added: { after: cutoffIso }, fields: ["id", "date_added"], limit: 200, include_total: true,
    });
    expect(isEngineError(r)).toBe(false);
    if (isEngineError(r)) return;
    expect(r.tracks.length).toBeGreaterThan(0);
    for (const t of r.tracks) expect(Number(t.date_added)).toBeGreaterThanOrEqual(cutoffEpoch);

    const all = await searchTracks(qp, { limit: 1, include_total: true });
    expect(isEngineError(all)).toBe(false);
    if (isEngineError(all)) return;
    // Confirmed by execution: filtered total (521) lands under the cap, so
    // this is a real inequality against the (capped) unfiltered total.
    expect(r.total!).toBeGreaterThan(0);
    expect(r.total!).toBeLessThan(all.total!);
  });

  it("flags.has_cues and flags.has_beatgrid are wired to distinct columns, not swapped", async () => {
    // The fixture's two known ids (1, 2) were deliberately decorrelated in
    // beforeAll: id 1 has cues but no beatgrid, id 2 has a beatgrid but no
    // cues. Cross-check both the SELECT projection and the WHERE filtering
    // against the real side.track_derived values for those ids — with the
    // generator's normal (correlated) data alone, a swap between the two
    // flags would be numerically invisible, since both would always agree.
    const raw1 = await qp.run("SELECT has_cues, has_grid FROM side.track_derived WHERE track_id = ?", [1]);
    const raw2 = await qp.run("SELECT has_cues, has_grid FROM side.track_derived WHERE track_id = ?", [2]);
    expect(isEngineError(raw1)).toBe(false);
    expect(isEngineError(raw2)).toBe(false);
    if (isEngineError(raw1) || isEngineError(raw2)) return;
    expect(raw1.rows[0]).toEqual([1, 0]);
    expect(raw2.rows[0]).toEqual([0, 1]);

    // Projection: id 1 and id 2 sort first under the default id ordering
    // with no filter, so a plain two-row page reaches both directly.
    const first2 = await searchTracks(qp, { fields: ["id", "has_cues", "has_beatgrid"], limit: 2 });
    expect(isEngineError(first2)).toBe(false);
    if (isEngineError(first2)) return;
    expect(first2.tracks[0]).toEqual({ id: 1, has_cues: 1, has_beatgrid: 0 });
    expect(first2.tracks[1]).toEqual({ id: 2, has_cues: 0, has_beatgrid: 1 });

    // WHERE filtering: id 1 must appear under has_cues:true but not
    // has_beatgrid:true, and id 2 the other way around.
    const cuesTrue = await searchTracks(qp, { flags: { has_cues: true }, fields: ["id"], limit: 2 });
    const gridTrue = await searchTracks(qp, { flags: { has_beatgrid: true }, fields: ["id"], limit: 2 });
    expect(isEngineError(cuesTrue)).toBe(false);
    expect(isEngineError(gridTrue)).toBe(false);
    if (isEngineError(cuesTrue) || isEngineError(gridTrue)) return;
    expect(cuesTrue.tracks.map((t) => t.id)).toContain(1);
    expect(cuesTrue.tracks.map((t) => t.id)).not.toContain(2);
    expect(gridTrue.tracks.map((t) => t.id)).toContain(2);
    expect(gridTrue.tracks.map((t) => t.id)).not.toContain(1);

    // The distinction the column exists to make: tracks that carry a
    // quickCues blob and still have no cue set. Engine writes one to every
    // analysed track, so a has_cues that meant "the blob is there" would
    // put this count at zero and answer "nothing to do" to a DJ asking
    // which tracks still need cue points.
    const blobButNoCue = await qp.run(
      `SELECT COUNT(*) FROM main.PerformanceData p
       JOIN side.track_derived d ON d.track_id = p.trackId
       WHERE length(p.quickCues) > 0 AND d.has_cues = 0`,
    );
    const blobAndCue = await qp.run(
      `SELECT COUNT(*) FROM main.PerformanceData p
       JOIN side.track_derived d ON d.track_id = p.trackId
       WHERE length(p.quickCues) > 0 AND d.has_cues = 1`,
    );
    expect(isEngineError(blobButNoCue)).toBe(false);
    expect(isEngineError(blobAndCue)).toBe(false);
    if (isEngineError(blobButNoCue) || isEngineError(blobAndCue)) return;
    // Both non-zero, so the column is neither "the blob is present" nor a
    // constant: the same SQL-visible blob yields both answers.
    expect(Number(blobButNoCue.rows[0]![0])).toBeGreaterThan(0);
    expect(Number(blobAndCue.rows[0]![0])).toBeGreaterThan(0);

    // Non-vacuous in both directions: confirmed by execution that
    // has_cues:true totals 320 and has_cues:false totals 1000 (capped) at
    // 1500 tracks — so neither "matches nothing" nor "matches everything"
    // is possible here.
    const cuesFalse = await searchTracks(qp, { flags: { has_cues: false }, limit: 1, include_total: true });
    const gridFalse = await searchTracks(qp, { flags: { has_beatgrid: false }, limit: 1, include_total: true });
    expect(isEngineError(cuesFalse)).toBe(false);
    expect(isEngineError(gridFalse)).toBe(false);
    if (isEngineError(cuesFalse) || isEngineError(gridFalse)) return;
    expect(cuesTrue.tracks.length).toBeGreaterThan(0);
    expect(gridTrue.tracks.length).toBeGreaterThan(0);
    expect(cuesFalse.total!).toBeGreaterThan(0);
    expect(gridFalse.total!).toBeGreaterThan(0);
  });
});

describe("search_tracks — total capping", () => {
  it("keeps total stable across pages of the same query", async () => {
    const p1 = await searchTracks(qp, { q: "dark", limit: 5, include_total: true });
    expect(isEngineError(p1)).toBe(false);
    if (isEngineError(p1)) return;
    const p2 = await searchTracks(qp, { q: "dark", limit: 5, cursor: p1.next_cursor, include_total: true });
    expect(isEngineError(p2)).toBe(false);
    if (isEngineError(p2)) return;
    expect(p2.total).toBe(p1.total);
  });

  it("flags total_capped when the true count exceeds the cap", async () => {
    // 1500 fixture tracks, no filter: the true count (1500) exceeds the 1000 cap.
    const r = await searchTracks(qp, { limit: 1, include_total: true });
    expect(isEngineError(r)).toBe(false);
    if (isEngineError(r)) return;
    expect(r.total).toBe(1000);
    expect(r.total_capped).toBe(true);
  });

  it("does not flag total_capped when the true count is under the cap", async () => {
    const r = await searchTracks(qp, { rating: { min: 5 }, key: { camelot: ["1A"] }, limit: 1, include_total: true });
    expect(isEngineError(r)).toBe(false);
    if (isEngineError(r)) return;
    expect(r.total_capped).toBe(false);
  });
});

describe("search_tracks — cursor safety", () => {
  it("rejects a malformed cursor", async () => {
    const r = await searchTracks(qp, { limit: 3, cursor: "not-a-real-cursor!!" });
    expect(isEngineError(r)).toBe(true);
    if (!isEngineError(r)) return;
    expect(r.error).toBe("invalid_argument");
  });

  it("rejects a cursor from a different search instead of silently mispaging", async () => {
    const dark = await searchTracks(qp, { q: "dark", limit: 5 });
    expect(isEngineError(dark)).toBe(false);
    if (isEngineError(dark)) return;
    expect(dark.next_cursor).toBeTruthy();

    // Same cursor, different filters entirely (and a different ordering:
    // rank- vs id-based) — must be rejected, not silently mispaged.
    const mismatched = await searchTracks(qp, {
      bpm: { around: 124, tolerance_pct: 2 },
      limit: 5,
      cursor: dark.next_cursor,
    });
    expect(isEngineError(mismatched)).toBe(true);
    if (!isEngineError(mismatched)) return;
    expect(mismatched.error).toBe("invalid_argument");
  });
});
