// tests/track-metadata-plan.test.ts
import { describe, it, expect } from "vitest";
import { err, isEngineError } from "../src/errors.js";
import { validateUpdates, writtenFields, listProblems, type TrackUpdate } from "../src/store/track-metadata-plan.js";

const refused = (updates: TrackUpdate[]) => {
  const e = validateUpdates(updates);
  expect(e, "expected a refusal").toBeDefined();
  expect(e!.error).toBe("invalid_argument");
  expect(e!.detail).toBe("not_committed");
  return e!.message;
};

describe("error codes", () => {
  it("recognises both new codes, or a refusal from inside a transaction would commit as success", () => {
    // withWriteTransaction tells a body's error from its result with
    // isEngineError, which checks membership in ERROR_CODES. A code missing
    // from that array is a refusal that COMMITs (spec §7.3).
    expect(isEngineError(err("stale_value", "x"))).toBe(true);
    expect(isEngineError(err("track_not_editable", "x"))).toBe(true);
  });

  it("carries structured mismatches", () => {
    const e = err("stale_value", "x", { mismatches: [{ id: 1, field: "genre", expected: "a", actual: "b" }] });
    expect(e.mismatches).toHaveLength(1);
  });
});

describe("writtenFields", () => {
  it("maps both rating inputs onto the one rating column, in a fixed order", () => {
    expect(writtenFields({ id: 1, year: 2020, genre: "x", rating_stars: 3 })).toEqual(["genre", "year", "rating"]);
    expect(writtenFields({ id: 1, rating_raw: 55, expect: { rating_raw: 60 } })).toEqual(["rating"]);
  });
});

describe("validateUpdates", () => {
  it("accepts an ordinary edit", () => {
    expect(validateUpdates([{ id: 1, genre: "Techno", rating_stars: 4, year: 2024 }])).toBeUndefined();
  });

  it("refuses an empty list", () => {
    refused([]);
  });

  it("refuses a track named twice", () => {
    expect(refused([{ id: 3, genre: "a" }, { id: 3, comment: "b" }])).toMatch(/track id 3 named more than once/);
  });

  it("refuses an update that changes nothing", () => {
    expect(refused([{ id: 1 }])).toMatch(/track 1: no field to change/);
  });

  it("refuses rating_stars and rating_raw together", () => {
    expect(refused([{ id: 1, rating_stars: 3, rating_raw: 60, expect: { rating_raw: 0 } }])).toMatch(/together/);
  });

  it("refuses rating_raw without expect.rating_raw, so 4 cannot be written meaning four stars", () => {
    // Spec §5.3: rating_raw is only for restoring an exact value.
    expect(refused([{ id: 1, rating_raw: 4 }])).toMatch(/needs expect.rating_raw/);
  });

  it("refuses expect on a field the update does not change", () => {
    expect(refused([{ id: 1, genre: "a", expect: { comment: "b" } }])).toMatch(/expect.comment names a field/);
    expect(refused([{ id: 1, genre: "a", expect: { rating_raw: 0 } }])).toMatch(/expect.rating_raw names a field/);
  });

  it("allows expect.rating_raw alongside rating_stars", () => {
    expect(validateUpdates([{ id: 1, rating_stars: 3, expect: { rating_raw: 80 } }])).toBeUndefined();
  });

  it("range-checks new values", () => {
    expect(refused([{ id: 1, rating_stars: 6 }])).toMatch(/rating_stars must be a whole number 0-5/);
    expect(refused([{ id: 1, year: 20240 }])).toMatch(/year must be 0 \(unknown\) or 1000-2200/);
    expect(refused([{ id: 1, comment: "x".repeat(1001) }])).toMatch(/comment is longer than 1000/);
    expect(validateUpdates([{ id: 1, year: 0 }])).toBeUndefined();
  });

  it("does not range-check a restore, which is a write carrying expect on that field", () => {
    // Spec §5.3: otherwise a track with year 20240905 could be fixed but not undone.
    expect(validateUpdates([{ id: 1, year: 20240905, expect: { year: 2024 } }])).toBeUndefined();
    expect(validateUpdates([{ id: 1, comment: "x".repeat(5000), expect: { comment: "short" } }])).toBeUndefined();
    expect(validateUpdates([{ id: 1, rating_raw: 196, expect: { rating_raw: 60 } }])).toBeUndefined();
  });

  it("still refuses rating_raw outside 0-255, restore or not", () => {
    expect(refused([{ id: 1, rating_raw: 256, expect: { rating_raw: 0 } }])).toMatch(/rating_raw must be a whole number 0-255/);
  });

  it("lists every problem at once, not only the first", () => {
    const m = refused([{ id: 1 }, { id: 2, rating_stars: 9 }, { id: 3, rating_raw: 7 }]);
    expect(m).toMatch(/track 1:/);
    expect(m).toMatch(/track 2:/);
    expect(m).toMatch(/track 3:/);
    expect(m).toMatch(/^3 problems/);
  });
});

describe("listProblems", () => {
  it("shows twenty and counts the rest", () => {
    const text = listProblems(Array.from({ length: 25 }, (_, i) => `p${i}`));
    expect(text).toContain("p19");
    expect(text).not.toContain("p20");
    expect(text).toMatch(/and 5 more$/);
  });
});
