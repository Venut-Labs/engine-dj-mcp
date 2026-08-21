// tests/fixtures/blob-frames.ts
//
// Builders for PerformanceData blobs in the layouts measured on a real
// Engine DJ 3.0.x library (see src/blobs/index.ts for the evidence behind
// each one, and tests/fixtures/blobs/ for the real bytes they imitate).
//
// These exist so the defensive-envelope tests can construct inputs the
// decoders will accept. They can never prove a layout is right — they are
// the same layout, written backwards — which is why the golden fixtures
// carry that burden instead. They live here rather than in one test file so
// that a layout correction has one place to land, not two that can drift.
import { deflateSync } from "node:zlib";

/** Qt qCompress framing: 4-byte BE uncompressed length + raw zlib stream. */
export function qCompress(payload: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, deflateSync(payload)]);
}

export const u8 = (n: number): Buffer => Buffer.from([n]);
export const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n, 0);
  return b;
};
export const i32le = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeInt32LE(n, 0);
  return b;
};
export const i64 = (n: number): Buffer => {
  const b = Buffer.alloc(8);
  b.writeBigInt64BE(BigInt(n), 0);
  return b;
};
export const i64le = (n: number): Buffer => {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(n), 0);
  return b;
};
export const f64 = (n: number): Buffer => {
  const b = Buffer.alloc(8);
  b.writeDoubleBE(n, 0);
  return b;
};
export const f64le = (n: number): Buffer => {
  const b = Buffer.alloc(8);
  b.writeDoubleLE(n, 0);
  return b;
};

export interface CueSlot {
  label: string;
  position: number;
  colour: number;
}
export interface MainCueFields {
  position: number;
  adjusted: number;
  fallback: number;
}
/**
 * quickCues: int64be slot count, then per slot uint8 label length + label +
 * float64be sample offset + 4 colour bytes, then float64be main cue + uint8
 * adjusted flag + float64be default main cue. Big-endian throughout.
 */
export function cueFrame(
  slots: CueSlot[],
  main: MainCueFields = { position: -1, adjusted: 0, fallback: -1 },
): Buffer {
  const parts = [i64(slots.length)];
  for (const s of slots) {
    const label = Buffer.from(s.label, "utf8");
    parts.push(u8(label.length), label, f64(s.position), u32(s.colour));
  }
  parts.push(f64(main.position), u8(main.adjusted), f64(main.fallback));
  return qCompress(Buffer.concat(parts));
}
/** An unused hot-cue slot: no label, sample offset -1.0, colour 0. */
export const emptyCue: CueSlot = { label: "", position: -1, colour: 0 };

export interface LoopSlot {
  label: string;
  start: number;
  end: number;
}
/**
 * loops: NOT compressed and NOT qCompress-framed, little-endian throughout.
 * int64le slot count, then per slot uint8 label length + label + float64le
 * start + float64le end + six bytes of flags and colour.
 */
export function loopBlob(slots: LoopSlot[]): Buffer {
  const parts = [i64le(slots.length)];
  for (const s of slots) {
    const label = Buffer.from(s.label, "utf8");
    parts.push(u8(label.length), label, f64le(s.start), f64le(s.end), Buffer.alloc(6));
  }
  return Buffer.concat(parts);
}
export const emptyLoop: LoopSlot = { label: "", start: -1, end: -1 };

export interface Anchor {
  sample: number;
  beat: number;
}
/**
 * beatData: float64be sample rate, float64be sample count, uint8 present
 * flag, then the default grid and the adjusted grid, each an int64be marker
 * count followed by 24-byte little-endian markers, then nine trailing bytes.
 */
export function beatFrame(
  adjusted: Anchor[],
  opts: { rate?: number; samples?: number; def?: Anchor[] } = {},
): Buffer {
  const rate = opts.rate ?? 44100;
  const grid = (anchors: Anchor[]) => {
    const parts = [i64(anchors.length)];
    anchors.forEach((a, i) => {
      const next = anchors[i + 1];
      parts.push(
        f64le(a.sample),
        i64le(a.beat),
        i32le(next ? next.beat - a.beat : 0),
        i32le(0), // the trailing int32 the decoder reads and discards
      );
    });
    return Buffer.concat(parts);
  };
  return qCompress(
    Buffer.concat([
      f64(rate),
      f64(opts.samples ?? rate * 100),
      u8(1),
      grid(opts.def ?? adjusted),
      grid(adjusted),
      Buffer.alloc(9),
    ]),
  );
}

/**
 * overviewWaveFormData: int64be point count twice, float64be samples per
 * point, three bytes per point, then a three-byte per-band maximum.
 */
export function waveFrame(
  points: [number, number, number][],
  samplesPerPoint = 14858,
): Buffer {
  const max = [0, 1, 2].map((k) => points.reduce((m, p) => Math.max(m, p[k]!), 0));
  return qCompress(
    Buffer.concat([
      i64(points.length),
      i64(points.length),
      f64(samplesPerPoint),
      Buffer.from(points.flat()),
      Buffer.from(max),
    ]),
  );
}
