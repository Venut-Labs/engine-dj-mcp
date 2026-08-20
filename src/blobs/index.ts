// src/blobs/index.ts
//
// Decoders for Engine's PerformanceData blob columns (trackData,
// overviewWaveFormData, beatData, quickCues, loops, activeOnLoadLoops).
// Framing (qCompress) is documented Qt behaviour and is verified by
// tests/blobs.test.ts round-tripping real zlib streams. The internal field
// layouts below are NOT verified against a real Engine library — they come
// from reading the Engine binary and from xsco/libdjinterop and
// jrgutier/rb2engine, and no byte from a real library has ever been run
// through them (see task-14-brief.md and task-14-report.md). Golden fixtures
// are a post-library checklist item.
//
// Because the layouts are best-effort guesses, every decoder here is built
// so a wrong guess degrades to a "corrupt"/"unsupported" status rather than
// an exception or a silently wrong value:
//   - every buffer read is bounds-checked (Reader#need in qcompress.ts)
//   - every count/length read from the blob is sanity-capped before use
//   - every decoded float is required to be finite
//   - one field's failure never prevents its siblings from decoding
import { qUncompress, Reader, DecodeError } from "./qcompress.js";

export type Decoded<T> =
  | { status: "ok"; items: T[] }
  | { status: "empty" }
  | { status: "unsupported"; detail: string; bytes: number }
  | { status: "corrupt"; detail: string };

export interface Cue {
  index: number;
  label: string;
  position_samples: number;
  colour: number;
}
export interface Loop {
  index: number;
  label: string;
  start_samples: number;
  end_samples: number;
}
export interface BeatAnchor {
  sample: number;
  beat: number;
}
export type WaveformSummary =
  | { status: "ok"; peaks: number; profile: number[] }
  | { status: "empty" }
  | { status: "unsupported"; detail: string; bytes: number }
  | { status: "corrupt"; detail: string };

// Sanity bounds: a corrupt length/count field must be refused rather than
// attempted, however large it claims to be. These are generous compared to
// any real cue/loop/beatgrid list, which never comes close to them.
const MAX_ITEMS = 512; // a real cue or loop list is nowhere near this
const MAX_ANCHORS = 8192; // a real beatgrid is nowhere near this either
const MAX_LABEL_LEN = 4096;

/** Reads a float64 that must be finite; a NaN/Infinity here means the
 * offset landed on the wrong bytes (corrupt data or a wrong layout guess),
 * not a legitimate value — silently returning NaN would later serialise as
 * `null` in JSON and read as "no value" rather than "decode failed". */
function finiteF64(r: Reader, what: string): number {
  const v = r.f64();
  if (!Number.isFinite(v)) throw new DecodeError(`${what} is not a finite number`);
  return v;
}

function guard<T>(buf: Buffer | null, body: (r: Reader) => T[]): Decoded<T> {
  if (!buf || buf.length === 0) return { status: "empty" };
  try {
    return { status: "ok", items: body(new Reader(qUncompress(buf))) };
  } catch (e) {
    const detail = (e as Error).message;
    return e instanceof DecodeError && /unsupported|signature/i.test(detail)
      ? { status: "unsupported", detail, bytes: buf.length }
      : { status: "corrupt", detail };
  }
}

export function decodeCues(buf: Buffer | null): Decoded<Cue> {
  return guard<Cue>(buf, (r) => {
    const count = r.u32();
    if (count > MAX_ITEMS) throw new DecodeError(`unsupported cue count ${count}`);
    const items: Cue[] = [];
    for (let i = 0; i < count; i++) {
      const len = r.u32();
      if (len > MAX_LABEL_LEN) throw new DecodeError(`unsupported label length ${len}`);
      items.push({
        index: i,
        label: r.utf8(len),
        position_samples: finiteF64(r, "cue position"),
        colour: r.u32(),
      });
    }
    return items;
  });
}

export function decodeLoops(buf: Buffer | null): Decoded<Loop> {
  return guard<Loop>(buf, (r) => {
    const count = r.u32();
    if (count > MAX_ITEMS) throw new DecodeError(`unsupported loop count ${count}`);
    const items: Loop[] = [];
    for (let i = 0; i < count; i++) {
      const len = r.u32();
      if (len > MAX_LABEL_LEN) throw new DecodeError(`unsupported label length ${len}`);
      items.push({
        index: i,
        label: r.utf8(len),
        start_samples: finiteF64(r, "loop start"),
        end_samples: finiteF64(r, "loop end"),
      });
    }
    return items;
  });
}

export function decodeBeatgrid(buf: Buffer | null): Decoded<BeatAnchor> {
  return guard<BeatAnchor>(buf, (r) => {
    const count = r.u32();
    if (count > MAX_ANCHORS) throw new DecodeError(`unsupported anchor count ${count}`);
    const items: BeatAnchor[] = [];
    for (let i = 0; i < count; i++) {
      items.push({ sample: finiteF64(r, "beat sample"), beat: finiteF64(r, "beat number") });
    }
    return items;
  });
}

/**
 * The raw waveform is kilobytes of binary and is never returned to the
 * model. We reduce it to a coarse per-bucket energy profile (peak byte value
 * per bucket, normalised to 0..1) plus the total sample count.
 */
export function summariseWaveform(buf: Buffer | null, buckets = 32): WaveformSummary {
  if (!buf || buf.length === 0) return { status: "empty" };
  try {
    const data = qUncompress(buf);
    if (data.length === 0) return { status: "empty" };
    const size = Math.ceil(data.length / buckets);
    const profile: number[] = [];
    for (let i = 0; i < data.length; i += size) {
      let peak = 0;
      for (let j = i; j < Math.min(i + size, data.length); j++) peak = Math.max(peak, data[j]!);
      profile.push(Math.round((peak / 255) * 100) / 100);
    }
    return { status: "ok", peaks: data.length, profile };
  } catch (e) {
    const detail = (e as Error).message;
    return e instanceof DecodeError && /unsupported|signature/i.test(detail)
      ? { status: "unsupported", detail, bytes: buf.length }
      : { status: "corrupt", detail };
  }
}

export interface PerformanceRow {
  quickCues: Buffer | null;
  loops: Buffer | null;
  beatData: Buffer | null;
  overviewWaveFormData: Buffer | null;
}

/**
 * Decodes every PerformanceData field independently. A failure in one field
 * (e.g. a corrupt beatgrid) never prevents the others from decoding — each
 * carries its own status rather than the call as a whole throwing or failing.
 */
export function decodePerformance(row: PerformanceRow): {
  cues: Decoded<Cue>;
  loops: Decoded<Loop>;
  beatgrid: Decoded<BeatAnchor>;
  waveform_summary: WaveformSummary;
} {
  return {
    cues: decodeCues(row.quickCues),
    loops: decodeLoops(row.loops),
    beatgrid: decodeBeatgrid(row.beatData),
    waveform_summary: summariseWaveform(row.overviewWaveFormData),
  };
}
