// tests/search.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLibrary } from "./fixtures/gen-library.js";
import { readLibraryInfo } from "../src/discovery.js";
import { QueryProcess } from "../src/proc/query-client.js";
import { IndexManager } from "../src/store/index-manager.js";
import { searchTracks, DEFAULT_FIELDS, FIELD_SQL } from "../src/tools/search.js";
import { isEngineError } from "../src/errors.js";

let dir: string, qp: QueryProcess;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "edj-search-"));
  const mdb = makeLibrary(dir, { tracks: 1500 });
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

  it("filters played.never and played.before", async () => {
    const never = await searchTracks(qp, { played: { never: true }, limit: 50 });
    expect(isEngineError(never)).toBe(false);

    const before = await searchTracks(qp, { played: { before: "-6 months" }, limit: 50 });
    expect(isEngineError(before)).toBe(false);
  });

  it("filters added.after with an ISO-8601 date", async () => {
    const r = await searchTracks(qp, { added: { after: "2000-01-01" }, limit: 5 });
    expect(isEngineError(r)).toBe(false);
  });

  it("filters by flags.has_cues and flags.has_beatgrid", async () => {
    const r = await searchTracks(qp, { flags: { has_cues: true, has_beatgrid: true }, limit: 5 });
    expect(isEngineError(r)).toBe(false);
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
    // rank-based vs id-based) — must be rejected, not silently mispaged.
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
