// tests/track-metadata-plan.test.ts
import { describe, it, expect } from "vitest";
import { err, isEngineError } from "../src/errors.js";
import { validateUpdates, writtenFields, listProblems, planUpdates, sameStored, type TrackUpdate, type CurrentRow, type Plan } from "../src/store/track-metadata-plan.js";

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

  it("does not let an expect on a different field lift the year range check", () => {
    // The range check for `year` looks only at `expect.year`; an expect on
    // some other field must not be read as covering it too.
    expect(refused([{ id: 1, year: 20240, genre: "x", expect: { genre: "y" } }]))
      .toMatch(/year must be 0 \(unknown\) or 1000-2200/);
  });

  it("refuses a lone surrogate as invalid Unicode text, in a value or in expect", () => {
    // Passes every other check here and reaches SQLite, which mangles it --
    // caught downstream as library_unreadable "did not read back as
    // written" instead of the invalid_argument this is.
    expect(refused([{ id: 1, genre: "a\uD800b" }])).toMatch(/track 1: genre is not valid Unicode text/);
    expect(refused([{ id: 1, genre: "a", expect: { genre: "a\uD800b" } }]))
      .toMatch(/track 1: genre is not valid Unicode text/);
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

const row = (over: Partial<CurrentRow> & { id: number }): CurrentRow => ({
  genre: "Techno", comment: null, label: null, year: 2020, rating: 0,
  inexpressible: [], originEmpty: false, ...over,
});
const rowsOf = (...rs: CurrentRow[]) => new Map(rs.map((r) => [r.id, r]));
const plan = (updates: TrackUpdate[], ...rs: CurrentRow[]) => {
  const p = planUpdates(updates, rowsOf(...rs));
  if (isEngineError(p)) throw new Error(`unexpected refusal: ${p.error} ${p.message}`);
  return p as Plan;
};
const refusal = (updates: TrackUpdate[], ...rs: CurrentRow[]) => {
  const p = planUpdates(updates, rowsOf(...rs));
  expect(isEngineError(p), "expected a refusal").toBe(true);
  expect((p as any).detail).toBe("not_committed");
  return p as any;
};

describe("sameStored", () => {
  it("treats NULL and '' as one empty for text, NULL and 0 for numbers, and nothing else", () => {
    expect(sameStored("comment", null, "")).toBe(true);
    expect(sameStored("year", null, 0)).toBe(true);
    expect(sameStored("rating", null, 0)).toBe(true);
    // Exact otherwise: no Unicode folding, or a real difference would be hidden.
    expect(sameStored("genre", "Électronique".normalize("NFC"), "Électronique".normalize("NFD"))).toBe(false);
  });
});

describe("planUpdates", () => {
  it("writes only the fields that differ", () => {
    const p = plan([{ id: 1, genre: "House", year: 2020 }], row({ id: 1 }));
    expect(p.writes).toEqual([{ id: 1, set: { genre: "House" }, fields: ["genre"] }]);
    expect(p.unchanged).toEqual([]);
  });

  it("leaves a track already at its target alone, whatever expect says", () => {
    // Spec §5.2: expect guards writes, and this row is not written. So a
    // repeated call, or an undo someone already applied by hand, is a no-op.
    const p = plan([{ id: 1, genre: "Techno", expect: { genre: "Something else" } }], row({ id: 1 }));
    expect(p.writes).toEqual([]);
    expect(p.unchanged).toEqual([1]);
    expect(p.undo).toEqual([]);
  });

  it("writes an empty string as NULL, and counts '' as already empty", () => {
    expect(plan([{ id: 1, genre: "" }], row({ id: 1 })).writes[0]!.set).toEqual({ genre: null });
    expect(plan([{ id: 1, comment: "" }], row({ id: 1, comment: null })).unchanged).toEqual([1]);
  });

  it("counts year 0 against NULL as unchanged", () => {
    expect(plan([{ id: 1, year: 0 }], row({ id: 1, year: null })).unchanged).toEqual([1]);
  });

  it("stores stars in Engine's units", () => {
    expect(plan([{ id: 1, rating_stars: 4 }], row({ id: 1 })).writes[0]!.set).toEqual({ rating: 80 });
  });

  it("builds an undo from the previous values, naming only the fields that changed", () => {
    const p = plan(
      [{ id: 1, genre: "House", comment: "sick", rating_stars: 4, year: 2020 }],
      row({ id: 1, genre: "Techno", comment: null, rating: 55, year: 2020 }),
    );
    expect(p.undo).toEqual([
      {
        id: 1,
        genre: "Techno",
        comment: "",
        rating_raw: 55,
        expect: { genre: "House", comment: "sick", rating_raw: 80 },
      },
    ]);
  });

  it("produces an undo that plans back to exactly the previous row", () => {
    const before = row({ id: 1, genre: "Techno", comment: "old", label: null, year: 20240905, rating: 196 });
    const edit = plan([{ id: 1, genre: "House", comment: "", year: 2024, rating_stars: 5 }], before);
    const after: CurrentRow = { ...before, ...edit.writes[0]!.set } as CurrentRow;
    expect(validateUpdates(edit.undo)).toBeUndefined();
    const back = plan(edit.undo, after);
    const restored: CurrentRow = { ...after, ...back.writes[0]!.set } as CurrentRow;
    for (const f of ["genre", "comment", "label", "year", "rating"] as const) {
      expect(sameStored(f, restored[f], before[f]), f).toBe(true);
    }
  });

  it("refuses unknown ids, listing all of them", () => {
    const e = refusal([{ id: 1, genre: "a" }, { id: 8, genre: "a" }, { id: 9, genre: "a" }], row({ id: 1 }));
    expect(e.error).toBe("unknown_track");
    expect(e.message).toMatch(/8/);
    expect(e.message).toMatch(/9/);
  });

  it("refuses to write a track with an empty origin, but not to find it already in place", () => {
    const e = refusal([{ id: 1, genre: "House" }], row({ id: 1, originEmpty: true }));
    expect(e.error).toBe("track_not_editable");
    expect(e.message).toMatch(/track 1/);
    expect(plan([{ id: 1, genre: "Techno" }], row({ id: 1, originEmpty: true })).unchanged).toEqual([1]);
  });

  it("refuses a field whose stored value it could not restore, and still edits the others", () => {
    const e = refusal([{ id: 1, rating_stars: 3 }], row({ id: 1, inexpressible: ["rating"] }));
    expect(e.error).toBe("track_not_editable");
    expect(plan([{ id: 1, genre: "House" }], row({ id: 1, inexpressible: ["rating"] })).writes).toHaveLength(1);
  });

  it("never calls an inexpressible stored value already at target", () => {
    // Read as null, a stored 999 would otherwise compare equal to 0 stars.
    const e = refusal([{ id: 1, rating_stars: 0 }], row({ id: 1, rating: null, inexpressible: ["rating"] }));
    expect(e.error).toBe("track_not_editable");
  });

  it("reports every expect mismatch, structured, capped at twenty", () => {
    const rows = Array.from({ length: 25 }, (_, i) => row({ id: i + 1, genre: "Techno" }));
    const updates = rows.map((r) => ({ id: r.id, genre: "House", expect: { genre: "Minimal" } }));
    const e = refusal(updates, ...rows);
    expect(e.error).toBe("stale_value");
    expect(e.mismatches).toHaveLength(20);
    expect(e.mismatches[0]).toEqual({ id: 1, field: "genre", expected: "Minimal", actual: "Techno" });
    expect(e.message).toMatch(/^25 expected values no longer match/);
  });

  it("spells out code points when two values differ only in Unicode form", () => {
    const e = refusal(
      [{ id: 1, genre: "Electronic", expect: { genre: "Électronique".normalize("NFC") } }],
      row({ id: 1, genre: "Électronique".normalize("NFD") }),
    );
    expect(e.message).toMatch(/U\+0301/);
  });

  it("compares expect.rating_raw exactly, not rounded to stars", () => {
    const e = refusal([{ id: 1, rating_stars: 4, expect: { rating_raw: 60 } }], row({ id: 1, rating: 55 }));
    expect(e.error).toBe("stale_value");
  });

  it("skips a stale expect on a field this update will not write, letting the other field's write through", () => {
    // Spec §5.2 (field-level, Ruling R7): expect guards writes. genre is
    // already at its target ("Techno") and so stays unwritten -- its stale
    // expect ("House") must not refuse the comment write.
    const p = plan(
      [{ id: 1, genre: "Techno", comment: "restored", expect: { genre: "House", comment: "new" } }],
      row({ id: 1, genre: "Techno", comment: "new" }),
    );
    expect(p.writes).toEqual([{ id: 1, set: { comment: "restored" }, fields: ["comment"] }]);
  });

  it("reports unknown tracks before anything else", () => {
    const e = refusal(
      [{ id: 1, genre: "a", expect: { genre: "wrong" } }, { id: 2, genre: "a" }],
      row({ id: 1 }),
    );
    expect(e.error).toBe("unknown_track");
  });
});
