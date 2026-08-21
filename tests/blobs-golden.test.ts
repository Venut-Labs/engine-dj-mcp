// tests/blobs-golden.test.ts
//
// The decoders, fed bytes copied out of a real Engine DJ 3.0.x library.
//
// tests/blobs.test.ts builds its input from the same layout the decoder
// reads, so it stays green no matter how wrong that layout is — which is how
// a decoder that reported `unsupported` for every real `loops` blob, and
// found zero cues in tracks that have them, once passed the whole suite.
// These fixtures cannot do that. The input is not ours, so the only way the
// expected values can be produced is by reading the bytes the way Engine
// wrote them.
//
// Each fixture also carries the track's `length` and `bpmAnalyzed` from the
// same database row, and the checks below hold the decode against them:
// a cue has to land inside the track, the beatgrid's implied tempo has to
// match the tempo Engine analysed, the waveform's declared point spacing has
// to multiply back out to the duration. Those are the predictions that
// separate a layout that parses from a layout that is right, and they are
// asserted here as well as in the goldens so that a re-recorded fixture
// cannot quietly bless a regression.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { qUncompress } from "../src/blobs/qcompress.js";
import { decodePerformance } from "../src/blobs/index.js";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "blobs");

interface Fixture {
  name: string;
  why: string;
  track_length_seconds: number;
  bpm_analyzed: number;
  blob_bytes: Record<string, number>;
  expect: ReturnType<typeof decodePerformance>;
}
const manifest = JSON.parse(readFileSync(join(DIR, "expected.json"), "utf8")) as {
  note: string;
  fixtures: Fixture[];
};

const FIELDS = ["quickCues", "loops", "beatData", "overviewWaveFormData"] as const;
function blobs(name: string): Record<(typeof FIELDS)[number], Buffer> {
  return Object.fromEntries(
    FIELDS.map((f) => [f, readFileSync(join(DIR, `${name}.${f}.bin`))]),
  ) as Record<(typeof FIELDS)[number], Buffer>;
}
function decode(f: Fixture) {
  return decodePerformance({ ...blobs(f.name), durationSeconds: f.track_length_seconds });
}

describe("golden fixtures from a real Engine library", () => {
  it("covers tracks that differ in the ways the layouts turn on", () => {
    // A fixture set that happened to be seven copies of the same shape would
    // prove far less than it appears to, so the spread is asserted rather
    // than assumed.
    const decoded = manifest.fixtures.map(decode);
    const cueBlobSizes = new Set(
      manifest.fixtures.map((f) => qUncompress(blobs(f.name).quickCues).length),
    );
    expect(cueBlobSizes).toEqual(new Set([129, 134])); // both real quickCues sizes
    expect(decoded.some((d) => d.cues.status === "ok" && d.cues.items.length > 0)).toBe(true);
    expect(decoded.some((d) => d.cues.status === "ok" && d.cues.items.length === 0)).toBe(true);
    expect(new Set(decoded.map((d) => d.sample_rate))).toEqual(new Set([44100, 48000]));
    const tempos = manifest.fixtures.map((f) => f.bpm_analyzed);
    expect(Math.max(...tempos) - Math.min(...tempos)).toBeGreaterThan(50);
    const lengths = manifest.fixtures.map((f) => f.track_length_seconds);
    expect(Math.max(...lengths) / Math.min(...lengths)).toBeGreaterThan(4);
  });

  it("stores loops uncompressed, so the qCompress path cannot read them", () => {
    // The single mistake that made every real track report unsupported. If a
    // future change routes loops through qUncompress again, this fails.
    for (const f of manifest.fixtures) {
      const raw = blobs(f.name).loops;
      expect(raw.length, f.name).toBe(192);
      expect(() => qUncompress(raw), f.name).toThrow();
    }
  });

  for (const f of manifest.fixtures) {
    describe(`${f.name} — ${f.why}`, () => {
      it("decodes to exactly the recorded values", () => {
        expect(decode(f)).toEqual(f.expect);
      });

      it("reads every blob to its declared size", () => {
        const b = blobs(f.name);
        for (const field of FIELDS) expect(b[field].length, field).toBe(f.blob_bytes[field]);
      });

      it("places every cue inside the track", () => {
        const d = decode(f);
        expect(d.cues.status).toBe("ok");
        if (d.cues.status !== "ok") return;
        expect(d.cues.slots).toBe(8); // eight hot-cue pads
        for (const cue of d.cues.items) {
          expect(cue.position_samples, cue.label).toBeGreaterThanOrEqual(0);
          expect(cue.position_seconds, cue.label).not.toBeNull();
          expect(cue.position_seconds!, cue.label).toBeLessThanOrEqual(f.track_length_seconds);
          expect(cue.index).toBeGreaterThanOrEqual(0);
          expect(cue.index).toBeLessThan(8);
        }
        const main = d.cues.main_cue.position_seconds;
        if (main !== null) {
          // Engine stores a main cue a hair before zero on some tracks, so
          // the floor is "not meaningfully negative", not "not negative".
          expect(main).toBeGreaterThanOrEqual(-1);
          expect(main).toBeLessThanOrEqual(f.track_length_seconds);
        }
      });

      it("implies the tempo Engine analysed, from a grid spanning the track", () => {
        const d = decode(f);
        expect(d.beatgrid.status).toBe("ok");
        if (d.beatgrid.status !== "ok") return;
        expect(d.beatgrid.bpm).not.toBeNull();
        // The check that a wrong offset or a wrong endianness cannot pass.
        expect(Math.abs(d.beatgrid.bpm! - f.bpm_analyzed)).toBeLessThan(0.5);
        expect(Math.abs(d.beatgrid.duration_seconds - f.track_length_seconds)).toBeLessThan(1.001);
        expect(d.beatgrid.items.length).toBeGreaterThanOrEqual(2);
        const last = d.beatgrid.items[d.beatgrid.items.length - 1]!;
        expect(last.seconds!).toBeGreaterThan(f.track_length_seconds * 0.9);
      });

      it("spaces the waveform's points to cover exactly the track", () => {
        const d = decode(f);
        expect(d.waveform_summary.status).toBe("ok");
        if (d.waveform_summary.status !== "ok") return;
        const w = d.waveform_summary;
        expect(w.entries).toBe(1024); // a fixed-size overview, not a per-second one
        expect(d.sample_rate).not.toBeNull();
        const covered = (w.entries * w.samples_per_entry) / d.sample_rate!;
        expect(Math.abs(covered - f.track_length_seconds)).toBeLessThan(1.001);
        expect(w.profile).toHaveLength(32);
        for (const v of w.profile) {
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
        // A real track is not silent, and is not clipped flat either.
        expect(Math.max(...w.profile)).toBeGreaterThan(0.2);
      });

      it("finds eight loop slots, none of them populated", () => {
        // Recorded as a fact about this library rather than as an
        // aspiration: it is precisely why the loops layout keeps its
        // unverified marker.
        const d = decode(f);
        expect(d.loops.status).toBe("ok");
        if (d.loops.status !== "ok") return;
        expect(d.loops.layout).toBe("unverified");
        expect(d.loops.slots).toBe(8);
        expect(d.loops.items).toEqual([]);
      });

      it("says the cue and beatgrid layouts are verified", () => {
        const d = decode(f);
        expect(d.cues.layout).toBe("verified");
        expect(d.beatgrid.layout).toBe("verified");
      });
    });
  }

  it("finds the labelled hot cue that makes one blob five bytes longer", () => {
    // 278 of the 281 real quickCues blobs inflate to 129 bytes and three to
    // 134. The difference is a five-character label in one slot, which is
    // only possible if the slot is variable-length — the single observation
    // that rules out the fixed-stride reading this decoder used to have.
    const f = manifest.fixtures.find((x) => x.name === "labelled-cue")!;
    const inflated = qUncompress(blobs(f.name).quickCues);
    expect(inflated.length).toBe(134);
    const d = decode(f);
    expect(d.cues.status).toBe("ok");
    if (d.cues.status !== "ok") return;
    expect(d.cues.items).toHaveLength(1);
    const cue = d.cues.items[0]!;
    expect(cue.label).toBe("Cue 8");
    expect(cue.index).toBe(7); // the pad the label names
    expect(Buffer.byteLength(cue.label, "utf8")).toBe(inflated.length - 129);
    expect(cue.position_seconds).toBeCloseTo(244.938, 3);
  });

  it("reads the two grids a track carries, reporting the adjusted one", () => {
    const f = manifest.fixtures.find((x) => x.name === "half-time-grid")!;
    const d = decode(f);
    expect(d.beatgrid.status).toBe("ok");
    if (d.beatgrid.status !== "ok") return;
    // This track's *default* grid runs at exactly half bpmAnalyzed; the
    // adjusted grid, which is what Engine plays, matches it. Reporting the
    // default one would halve the tempo of seven tracks in the reference
    // library without anything looking wrong.
    expect(d.beatgrid.grid).toBe("adjusted");
    expect(d.beatgrid.bpm).toBeCloseTo(f.bpm_analyzed, 1);
    expect(f.bpm_analyzed).toBeCloseTo(170, 1);
  });

  it("keeps the fixtures free of anything identifying the user's music", () => {
    // These are the user's own library bytes. The blobs are cue offsets,
    // beat markers and waveform levels; the manifest must not turn them back
    // into a record of what they listen to.
    const raw = readFileSync(join(DIR, "expected.json"), "utf8");
    for (const key of ["title", "artist", "album", "path", "filename", "genre", "uri"]) {
      expect(raw.toLowerCase()).not.toContain(`"${key}"`);
    }
  });
});
