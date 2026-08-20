import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { makeLibrary } from "./fixtures/gen-library.js";
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

/** Qt qCompress framing: 4-byte BE uncompressed length + raw zlib stream. */
function qCompress(payload: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, deflateSync(payload)]);
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n, 0);
  return b;
}
function f64(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeDoubleBE(n, 0);
  return b;
}
function labeled(label: string): Buffer {
  const l = Buffer.from(label, "utf8");
  return Buffer.concat([u32(l.length), l]);
}

/** count:u32be, then per cue: label(len-prefixed), position:f64be, colour:u32be */
function cueFrame(cues: { label: string; position: number; colour: number }[]): Buffer {
  const parts = [u32(cues.length)];
  for (const c of cues) parts.push(labeled(c.label), f64(c.position), u32(c.colour));
  return qCompress(Buffer.concat(parts));
}

/** count:u32be, then per loop: label(len-prefixed), start:f64be, end:f64be */
function loopFrame(loops: { label: string; start: number; end: number }[]): Buffer {
  const parts = [u32(loops.length)];
  for (const l of loops) parts.push(labeled(l.label), f64(l.start), f64(l.end));
  return qCompress(Buffer.concat(parts));
}

/** count:u32be, then per anchor: sample:f64be, beat:f64be */
function beatgridFrame(anchors: { sample: number; beat: number }[]): Buffer {
  const parts = [u32(anchors.length)];
  for (const a of anchors) parts.push(f64(a.sample), f64(a.beat));
  return qCompress(Buffer.concat(parts));
}

/** Create a test library with well-formed performance data */
function makeWellFormedLibrary(dir: string): { dbPath: string; db: DatabaseSync } {
  const libraryPath = makeLibrary(dir, { tracks: 2 });
  const db = new DatabaseSync(libraryPath);

  // Insert well-formed data for track 1
  const cuesBlob = cueFrame([
    { label: "Intro", position: 1000, colour: 0xff0000 },
    { label: "Break", position: 50000, colour: 0x00ff00 },
  ]);
  const loopsBlob = loopFrame([{ label: "Main", start: 10000, end: 40000 }]);
  const beatgridBlob = beatgridFrame([
    { sample: 0, beat: 0 },
    { sample: 44100, beat: 1 },
  ]);

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
    // The fixture stores zero-filled blobs, which are not valid frames.
    const r = await getTrackPerformance(qp, { id: 1 });
    expect(isEngineError(r)).toBe(false);
    if (isEngineError(r)) return;
    expect(r.track_id).toBe(1);
    for (const key of ["cues", "loops", "beatgrid", "waveform_summary"] as const) {
      expect(["ok", "empty", "corrupt", "unsupported"]).toContain((r as any)[key].status);
    }
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
        expect((r as any).cues.items).toHaveLength(2);
        expect((r as any).cues.items[0].label).toBe("Intro");
        expect((r as any).cues.items[0].position_samples).toBe(1000);
        expect((r as any).cues.items[0].colour).toBe(0xff0000);
        expect((r as any).cues.items[1].label).toBe("Break");

        expect((r as any).loops.status).toBe("ok");
        expect((r as any).loops.items).toHaveLength(1);
        expect((r as any).loops.items[0].label).toBe("Main");
        expect((r as any).loops.items[0].start_samples).toBe(10000);
        expect((r as any).loops.items[0].end_samples).toBe(40000);

        expect((r as any).beatgrid.status).toBe("ok");
        expect((r as any).beatgrid.items).toHaveLength(2);
        expect((r as any).beatgrid.items[0].sample).toBe(0);
        expect((r as any).beatgrid.items[0].beat).toBe(0);
        expect((r as any).beatgrid.items[1].sample).toBe(44100);
        expect((r as any).beatgrid.items[1].beat).toBe(1);
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

        // Loops should be corrupt or unsupported, not fail the entire call
        const loopsStatus = (r as any).loops.status;
        expect(["corrupt", "unsupported"]).toContain(loopsStatus);

        // Beatgrid should be corrupt or empty (zero-filled from fixture)
        const beatgridStatus = (r as any).beatgrid.status;
        expect(["corrupt", "empty", "unsupported"]).toContain(beatgridStatus);

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
