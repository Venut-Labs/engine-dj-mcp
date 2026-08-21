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

/**
 * Every cue/loop/beatgrid field carries this. `status: "ok"` says only that
 * the bytes parsed without contradicting the guessed layout -- it is not a
 * claim that the values are right. Two of the layouts here are already known
 * to be wrong against real Engine data, and a fixed-slot quickCues array
 * whose leading u32 happens to be small parses cleanly into finite floats and
 * fabricated cue positions. An assistant reading a bare "ok" would repeat
 * those to a user as fact, so the uncertainty travels with the data rather
 * than living only in this file's header comment.
 *
 * Remove this marker when golden fixtures from a real library land (already
 * a scheduled post-library checklist item), not before.
 */
export const LAYOUT_UNVERIFIED = "unverified" as const;

export type Decoded<T> = { layout: typeof LAYOUT_UNVERIFIED } & (
  | { status: "ok"; items: T[]; total: number; truncated: boolean }
  | { status: "empty" }
  | { status: "unsupported"; detail: string; bytes: number }
  | { status: "corrupt"; detail: string }
);

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
  | {
      status: "ok";
      /** How many peak values `profile` holds — one per bucket. */
      peaks: number;
      /** Size of the decompressed waveform blob, in bytes. */
      bytes: number;
      /** Track length in seconds, from Track.length; null when unknown. */
      duration_seconds: number | null;
      profile: number[];
    }
  | { status: "empty" }
  | { status: "unsupported"; detail: string; bytes: number }
  | { status: "corrupt"; detail: string };

// Sanity bounds: a corrupt length/count field must be refused rather than
// attempted, however large it claims to be. These are generous compared to
// any real cue/loop/beatgrid list, which never comes close to them.
//
// These are *parse* bounds, not response bounds — see MAX_RETURNED below.
const MAX_ITEMS = 512; // a real cue or loop list is nowhere near this
const MAX_ANCHORS = 8192; // a real beatgrid is nowhere near this either
const MAX_LABEL_LEN = 4096;

/**
 * How many items of a decoded field actually reach the caller. The parse
 * bounds above have to be generous enough to accept anything real; this one
 * exists because the result lands in an LLM's context, and `reply()`
 * serialises it twice (once as text, once as structuredContent). 8192
 * beatgrid anchors — reachable from a single wrong layout guess producing a
 * garbage count — is roughly a megabyte of context spent on fabricated
 * numbers. audit_library already answers with a count plus a sample of ten
 * for the same reason; this is the same trade, with a larger sample because
 * a real cue list usually fits inside it whole.
 */
const MAX_RETURNED = 64;

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
  const layout = LAYOUT_UNVERIFIED;
  if (!buf || buf.length === 0) return { layout, status: "empty" };
  try {
    // Parsed in full (the buffer has to be walked to be validated at all),
    // returned bounded.
    const all = body(new Reader(qUncompress(buf)));
    return {
      layout,
      status: "ok",
      items: all.slice(0, MAX_RETURNED),
      total: all.length,
      truncated: all.length > MAX_RETURNED,
    };
  } catch (e) {
    const detail = (e as Error).message;
    return e instanceof DecodeError && /unsupported|signature/i.test(detail)
      ? { layout, status: "unsupported", detail, bytes: buf.length }
      : { layout, status: "corrupt", detail };
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
 * per bucket, normalised to 0..1).
 *
 * `peaks` counts the peak values in `profile`, which is what the field name
 * says. It previously reported `data.length` — the decompressed *byte* count
 * under a name promising a peak count. That is a units error crossing into
 * the model's context, the same class of defect as the bpm×100 scaling this
 * project already had to correct; the byte count is still reported, as
 * `bytes`, where the name matches the value.
 *
 * `duration_seconds` comes from Track.length, not from the blob: the
 * waveform's own sample-rate/point-spacing encoding is unverified, so
 * deriving a duration from `bytes` would be a guess presented as a
 * measurement.
 */
export function summariseWaveform(
  buf: Buffer | null,
  buckets = 32,
  durationSeconds: number | null = null,
): WaveformSummary {
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
    return {
      status: "ok",
      peaks: profile.length,
      bytes: data.length,
      duration_seconds: durationSeconds,
      profile,
    };
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
  /** Track.length in seconds, if known; reported by the waveform summary. */
  durationSeconds?: number | null;
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
    waveform_summary: summariseWaveform(row.overviewWaveFormData, 32, row.durationSeconds ?? null),
  };
}
