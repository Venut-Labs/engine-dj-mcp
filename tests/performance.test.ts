import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { makeLibrary } from "./fixtures/gen-library.js";
import {
  cueFrame,
  emptyCue,
  loopBlob,
  beatFrame,
  waveFrame,
  type CueSlot,
} from "./fixtures/blob-frames.js";
import { QueryProcess } from "../src/proc/query-client.js";
import { getTrackPerformance } from "../src/tools/performance.js";
import { isEngineError } from "../src/errors.js";

let dir: string, qp: QueryProcess;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "edj-perf-"));
  qp = new QueryProcess(makeLibrary(dir, { tracks: 50 }), null, 5000);
});
afterAll(() => {
  qp.dispose();
  rmSync(dir, { recursive: true, force: true });
});

/** Create a test library with well-formed performance data */
function makeWellFormedLibrary(dir: string): { dbPath: string; db: DatabaseSync } {
  const libraryPath = makeLibrary(dir, { tracks: 2 });
  const db = new DatabaseSync(libraryPath);

  // Well-formed data for track 1, in the eight-slot shape a real library
  // uses: two pads set, six left at the -1.0 marker.
  const slots: CueSlot[] = [...Array(8)].map(() => ({ ...emptyCue }));
  slots[0] = { label: "Intro", position: 1000, colour: 0xff0000 };
  slots[3] = { label: "Break", position: 50000, colour: 0x00ff00 };
  const cuesBlob = cueFrame(slots);
  const loopsBlob = loopBlob([{ label: "Main", start: 10000, end: 40000 }]);
  const beatgridBlob = beatFrame(
    [
      { sample: 0, beat: 0 },
      { sample: 44100 * 60, beat: 120 },
    ],
    { rate: 44100, samples: 44100 * 120 },
  );

  db.prepare("UPDATE PerformanceData SET quickCues = ?, loops = ?, beatData = ? WHERE trackId = 1")
    .run(cuesBlob, loopsBlob, beatgridBlob);

  // Insert mixed data for track 2: valid cues, corrupt loops
  const cuesBlob2 = cueFrame([{ label: "Intro", position: 1000, colour: 0xff0000 }]);
  const corruptBlob = Buffer.from([0x00, 0x00, 0x00, 0x01]);

  db.prepare("UPDATE PerformanceData SET quickCues = ?, loops = ? WHERE trackId = 2")
    .run(cuesBlob2, corruptBlob);

  return { dbPath: libraryPath, db };
}

describe("get_track_performance", () => {
  it("returns a per-field status instead of failing the call", async () => {
    // The fixture is deterministic (seeded PRNG): track 1 carries a real
    // eight-slot quickCues frame with no pad used, a 64-byte zero-filled
    // beatData -- not a valid qCompress frame -- and no loops or waveform at
    // all. Asserting the single expected status per field, rather than
    // "one of ok/empty/corrupt/unsupported", is the difference between
    // covering the behaviour and covering nothing: the loose form passes
    // whatever the decoders do.
    const r = await getTrackPerformance(qp, { id: 1 });
    expect(isEngineError(r)).toBe(false);
    if (isEngineError(r)) return;
    expect(r.track_id).toBe(1);
    // ok with nothing in it: an analysed track that has no cue set. This is
    // the state Engine leaves on almost every track, and the reason
    // has_cues cannot be answered by asking whether the blob is there.
    expect((r as any).cues.status).toBe("ok");
    expect((r as any).cues.items).toEqual([]);
    expect((r as any).cues.slots).toBe(8);
    expect((r as any).beatgrid.status).toBe("corrupt");
    expect((r as any).loops.status).toBe("empty");
    expect((r as any).waveform_summary.status).toBe("empty");
  });

  it("says which layouts were confirmed against real Engine data and which were not", async () => {
    // The cue and beatgrid layouts were checked against 281 real blobs; the
    // loop layout could not be, because no track in that library has a loop
    // set. The marker travels with the data so a model reading the response
    // does not have to guess which is which.
    const r = await getTrackPerformance(qp, { id: 1 });
    expect(isEngineError(r)).toBe(false);
    if (isEngineError(r)) return;
    expect((r as any).cues.layout).toBe("verified");
    expect((r as any).beatgrid.layout).toBe("verified");
    expect((r as any).loops.layout).toBe("verified");
  });

  it("reports an unknown track as a structured error", async () => {
    const r = await getTrackPerformance(qp, { id: 999999 });
    expect(isEngineError(r)).toBe(true);
  });

  it("decodes well-formed cues and returns status ok", async () => {
    // Create a temporary library with well-formed cue data
    const tempDir = mkdtempSync(join(tmpdir(), "edj-perf-well-formed-"));
    try {
      const { dbPath, db } = makeWellFormedLibrary(tempDir);
      db.close();

      const tempQp = new QueryProcess(dbPath, null, 5000);
      try {
        const r = await getTrackPerformance(tempQp, { id: 1 });
        expect(isEngineError(r)).toBe(false);
        if (isEngineError(r)) return;

        expect(r.track_id).toBe(1);
        expect((r as any).cues.status).toBe("ok");
        // Two pads set out of eight slots: the six unused ones are not cues.
        expect((r as any).cues.slots).toBe(8);
        expect((r as any).cues.items).toHaveLength(2);
        expect((r as any).cues.items[0].label).toBe("Intro");
        expect((r as any).cues.items[0].index).toBe(0);
        expect((r as any).cues.items[0].position_samples).toBe(1000);
        expect((r as any).cues.items[0].colour).toBe(0xff0000);
        expect((r as any).cues.items[1].label).toBe("Break");
        expect((r as any).cues.items[1].index).toBe(3); // the pad, not the position in the list

        // The sample rate only beatData carries reaches the cue positions.
        expect((r as any).sample_rate).toBe(44100);
        expect((r as any).cues.items[1].position_seconds).toBeCloseTo(50000 / 44100, 3);

        expect((r as any).loops.status).toBe("ok");
        expect((r as any).loops.items).toHaveLength(1);
        expect((r as any).loops.items[0].label).toBe("Main");
        expect((r as any).loops.items[0].start_samples).toBe(10000);
        expect((r as any).loops.items[0].end_samples).toBe(40000);

        expect((r as any).beatgrid.status).toBe("ok");
        expect((r as any).beatgrid.items).toHaveLength(2);
        expect((r as any).beatgrid.items[0].sample).toBe(0);
        expect((r as any).beatgrid.items[0].beat).toBe(0);
        expect((r as any).beatgrid.items[1].sample).toBe(44100 * 60);
        expect((r as any).beatgrid.items[1].beat).toBe(120);
        expect((r as any).beatgrid.bpm).toBeCloseTo(120, 3);
      } finally {
        tempQp.dispose();
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("bounds a huge cue list and reports the track duration with the waveform", async () => {
    // 300 cues is well inside the 512 parse cap but far outside anything
    // worth putting in an LLM's context -- and reply() serialises the
    // payload twice. A wrong layout guess yielding a large-but-plausible
    // count is exactly how this happens in the field.
    const tempDir = mkdtempSync(join(tmpdir(), "edj-perf-bounded-"));
    try {
      const dbPath = makeLibrary(tempDir, { tracks: 2 });
      const db = new DatabaseSync(dbPath);
      const many = Array.from({ length: 300 }, (_, i) => ({
        label: `cue ${i}`,
        position: i * 1000 + 1,
        colour: i,
      }));
      const wavePoints: [number, number, number][] = [
        [0, 64, 128],
        [255, 32, 16],
        [8, 4, 2],
      ];
      db.prepare(
        "UPDATE PerformanceData SET quickCues = ?, overviewWaveFormData = ? WHERE trackId = 1",
      ).run(cueFrame(many), waveFrame(wavePoints, 4096));
      // Track.length for the seeded fixture's id 1 is 389 seconds.
      const trackLength = Number(
        (db.prepare("SELECT length FROM Track WHERE id = 1").get() as any).length,
      );
      db.close();

      const tempQp = new QueryProcess(dbPath, null, 5000);
      try {
        const r = await getTrackPerformance(tempQp, { id: 1 });
        expect(isEngineError(r)).toBe(false);
        if (isEngineError(r)) return;

        expect((r as any).cues.status).toBe("ok");
        expect((r as any).cues.items).toHaveLength(64);
        expect((r as any).cues.total).toBe(300);
        expect((r as any).cues.truncated).toBe(true);

        const wave = (r as any).waveform_summary;
        expect(wave.status).toBe("ok");
        // peaks must count peak values, not decompressed bytes: the profile
        // has 8 bytes across 32 buckets, so peaks is 8 either way here --
        // pin it to profile.length so the two can never disagree.
        expect(wave.peaks).toBe(wave.profile.length);
        expect(wave.entries).toBe(3);
        expect(wave.samples_per_entry).toBe(4096);
        expect(wave.bytes).toBe(24 + 3 * 3 + 3);
        expect(wave.duration_seconds).toBe(trackLength);
        expect(wave.duration_seconds).toBeGreaterThan(0);
      } finally {
        tempQp.dispose();
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("preserves per-field status for mixed valid and corrupt data", async () => {
    // Create a temporary library with mixed well-formed and corrupt data
    const tempDir = mkdtempSync(join(tmpdir(), "edj-perf-mixed-"));
    try {
      const { dbPath, db } = makeWellFormedLibrary(tempDir);
      db.close();

      const tempQp = new QueryProcess(dbPath, null, 5000);
      try {
        // Track 2 has valid cues and corrupt loops
        const r = await getTrackPerformance(tempQp, { id: 2 });
        expect(isEngineError(r)).toBe(false);
        if (isEngineError(r)) return;

        // Cues should be OK
        expect((r as any).cues.status).toBe("ok");
        expect((r as any).cues.items).toHaveLength(1);
        expect((r as any).cues.items[0].label).toBe("Intro");

        // The loops blob is four bytes, and a loops blob opens with an
        // eight-byte little-endian slot count, so this is "corrupt" and
        // nothing else. The fixture is deterministic, so a range of accepted
        // statuses here asserted nothing.
        expect((r as any).loops.status).toBe("corrupt");
        expect((r as any).loops.detail).toMatch(/need 8 bytes/i);

        // Track 2's beatData is the generator's 64 zero bytes, untouched by
        // makeWellFormedLibrary: also a specific, deterministic outcome.
        expect((r as any).beatgrid.status).toBe("corrupt");

        // The entire call should succeed even though loops failed
        expect(r).toHaveProperty("track_id");
        expect(r).toHaveProperty("cues");
        expect(r).toHaveProperty("loops");
        expect(r).toHaveProperty("beatgrid");
      } finally {
        tempQp.dispose();
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
