import { describe, it, expect } from "vitest";
import { camelot, keyName, tempo, camelotNeighbours, keyDistance } from "../src/semantics.js";

describe("camelot", () => {
  it("maps Engine key indices onto the Camelot wheel", () => {
    expect(camelot(0)).toBe("8B");
    expect(camelot(1)).toBe("8A");
    expect(camelot(2)).toBe("9B");
    expect(camelot(3)).toBe("9A");
    expect(camelot(4)).toBe("10B");
    expect(camelot(5)).toBe("10A");
  });

  it("returns null for an undetermined key", () => {
    expect(camelot(-1)).toBeNull();
    expect(camelot(null)).toBeNull();
  });

  it("returns null for NaN", () => {
    expect(camelot(NaN)).toBeNull();
  });

  it("is a bijection over the 24 wheel positions", () => {
    const labels = new Set<string>();
    for (let k = 0; k < 24; k++) labels.add(camelot(k)!);
    expect(labels.size).toBe(24);
  });
});

describe("keyName", () => {
  it("maps the four wheel anchors to their note names", () => {
    expect(keyName(0)).toBe("C");
    expect(keyName(1)).toBe("Am");
    expect(keyName(2)).toBe("G");
    expect(keyName(3)).toBe("Em");
  });

  it("returns null for an undetermined key", () => {
    expect(keyName(-1)).toBeNull();
    expect(keyName(null)).toBeNull();
  });

  it("produces 24 distinct note names for all 24 key indices", () => {
    const names = new Set<string>();
    for (let k = 0; k < 24; k++) {
      const name = keyName(k);
      if (name) names.add(name);
    }
    expect(names.size).toBe(24);
  });
});

describe("tempo", () => {
  it("prefers the analysed value and uses the stored bpm at face value", () => {
    expect(tempo(128.03, 128)).toBeCloseTo(128.03, 2);
    expect(tempo(null, 128)).toBeCloseTo(128.0, 2);
    expect(tempo(null, null)).toBeNull();
  });

  /**
   * Regression for the ×100 defect: the project originally assumed `bpm` is
   * stored the way rekordbox stores it (12800 = 128.0 BPM), a claim carried
   * into the design doc from rekordbox documentation by mistake. Measured
   * against a real Engine DJ 5.0 library, schema 3.0.2 (the history
   * database, 24 genuinely analysed tracks), `bpm` is a plain BPM integer
   * that agrees with `bpmAnalyzed` to within 0.68:
   *
   *   id=1  bpm=102  bpmAnalyzed=102                  ratio 1.000
   *   id=2  bpm=105  bpmAnalyzed=105                  ratio 1.000
   *   id=4  bpm=145  bpmAnalyzed=145.00000000000003   ratio 1.000
   *   id=5  bpm=147  bpmAnalyzed=147.67619323730474   ratio 0.995
   *   id=6  bpm=128  bpmAnalyzed=128                  ratio 1.000
   *   id=7  bpm=129  bpmAnalyzed=129                  ratio 1.000
   *
   * This is an observation from a real library, not a preference: a track
   * carrying only an integer `bpm` and no `bpmAnalyzed` must resolve to
   * that same integer.
   */
  it("resolves a bare integer bpm to itself when bpmAnalyzed is absent", () => {
    expect(tempo(null, 102)).toBe(102);
    expect(tempo(null, 128)).toBe(128);
    expect(tempo(undefined as unknown as null, 145)).toBe(145);
  });
});

describe("harmonic neighbours", () => {
  it("returns the relative mode and both wheel neighbours", () => {
    expect(new Set(camelotNeighbours("8A"))).toEqual(new Set(["8A", "8B", "7A", "9A"]));
  });

  it("wraps around the wheel", () => {
    expect(new Set(camelotNeighbours("1A"))).toEqual(new Set(["1A", "1B", "12A", "2A"]));
  });

  it("measures distance around the wheel, not linearly", () => {
    expect(keyDistance("1A", "12A")).toBe(1);
    expect(keyDistance("1A", "7A")).toBe(6);
    expect(keyDistance("1A", "nonsense")).toBeNull();
  });
});
