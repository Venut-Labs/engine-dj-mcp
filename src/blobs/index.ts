// src/blobs/index.ts
//
// Decoders for Engine's PerformanceData blob columns (overviewWaveFormData,
// beatData, quickCues, loops).
//
// The layouts below were derived from, and checked against, a real Engine DJ
// library: 257 analysed tracks on a USB export plus 24 in the local history
// database, 281 blobs of each kind. What each check proved is recorded next
// to the decoder it justifies. `loops` is the one field whose *contents*
// could not be checked — see decodeLoops.
//
// Framing: `quickCues`, `beatData` and `overviewWaveFormData` are Qt
// qCompress frames (4-byte big-endian uncompressed length, then a raw zlib
// stream); the declared length matched the inflated length for all 281 of
// each. `loops` is NOT compressed and NOT framed — it is 192 raw bytes, and
// running it through the qCompress path reads its little-endian int64 count
// of 8 as a big-endian length of 134217728 and hands zlib bytes it rejects.
//
// The defensive envelope is unchanged by the layouts becoming known, because
// the blobs are not necessarily the user's own: defaultRoots() scans
// /Volumes, so a USB stick prepared by someone else is an ordinary input.
//   - every buffer read is bounds-checked (Reader#need in qcompress.ts)
//   - every count/length read from the blob is sanity-capped before use
//   - every decoded float is required to be finite
//   - one field's failure never prevents its siblings from decoding
//   - responses stay bounded regardless of what a blob claims
import { qUncompress, Reader, DecodeError } from "./qcompress.js";

/**
 * Whether a field's binary layout has been checked against real Engine data.
 *
 * `"verified"` means the layout was derived from a real library and confirmed
 * by predictions that could have failed: cue positions landing inside the
 * track, a beatgrid whose implied tempo matches `Track.bpmAnalyzed`, a
 * waveform whose declared bucket spacing multiplies back out to the track's
 * sample count. `status: "ok"` on a verified field is a claim about the
 * values, not merely about the parse.
 *
 * `"unverified"` still means what it always did: the bytes parsed without
 * contradicting the layout, and nothing more. It survives on `loops` because
 * no track in the 281 examined has a loop set, so while the slot structure is
 * pinned down, the meaning of a *populated* slot is untested.
 *
 * The marker is about the *bytes*: which offset holds which field, and what
 * the numbers there mean. It is not a claim about every English word this
 * module attaches to them. Three labels are inferred rather than measured and
 * say so at their own definitions — the cue colour's channel order, the
 * beatgrid's `grid: "adjusted"` and `main_cue.is_adjusted` naming, and the
 * waveform's low/mid/high band naming. Each names a field whose *value* is
 * pinned by the evidence below; only the name is a reading of it.
 */
export const LAYOUT_VERIFIED = "verified" as const;
export const LAYOUT_UNVERIFIED = "unverified" as const;
export type LayoutStatus = typeof LAYOUT_VERIFIED | typeof LAYOUT_UNVERIFIED;

export type Decoded<T, X = object> = { layout: LayoutStatus } & (
  | ({ status: "ok"; items: T[]; total: number; truncated: boolean } & X)
  | { status: "empty" }
  | { status: "unsupported"; detail: string; bytes: number }
  | { status: "corrupt"; detail: string }
);

export interface Cue {
  /** Hot-cue slot, 0-based: `index: 7` is the pad labelled "Cue 8". */
  index: number;
  label: string;
  position_samples: number;
  /** position_samples converted with beatData's sample rate; null if unknown. */
  position_seconds: number | null;
  /**
   * The slot's four colour bytes as one big-endian unsigned 32-bit value.
   * Which byte is which channel is NOT confirmed — see decodeCues.
   */
  colour: number;
}
/** The track's main cue (the CUE button), which lives in the quickCues blob. */
export interface MainCue {
  position_samples: number | null;
  position_seconds: number | null;
  /**
   * The second of the blob's two main-cue doubles. Read as Engine's stored
   * default, before any adjustment — see `is_adjusted` on why that reading is
   * inferred rather than measured.
   */
  default_samples: number | null;
  /**
   * The single byte between the two main-cue doubles, as a boolean.
   *
   * Not verified: that "adjusted" is what the byte means. Its *position* is
   * pinned (the layout parses to the last byte on all 281 blobs, and moving
   * this byte would misalign the double after it), and it is 0 or 1 with no
   * other value seen. The name comes from a correlation that mostly holds
   * and does not quite: the byte is set on 10 of the 281 real blobs, and on
   * 8 of those the two doubles differ — but on 2 it is set while they are
   * identical, and on 17 more the doubles differ with the byte clear (25
   * differ in total). Treat it as "a flag Engine sets about the main cue",
   * not as a measured meaning.
   */
  is_adjusted: boolean;
}
export interface Loop {
  index: number;
  label: string;
  start_samples: number;
  end_samples: number;
  start_seconds: number | null;
  end_seconds: number | null;
}
export interface BeatAnchor {
  /** Sample offset of the anchor; may be negative (Engine anchors before 0). */
  sample: number;
  /** Beat number at that sample; may be negative for the same reason. */
  beat: number;
  seconds: number | null;
}
export type CuesResult = Decoded<Cue, { slots: number; main_cue: MainCue }>;
export type LoopsResult = Decoded<Loop, { slots: number }>;
export type BeatgridResult = Decoded<
  BeatAnchor,
  {
    sample_rate: number;
    sample_count: number;
    duration_seconds: number;
    /** Tempo implied by the anchors, or null if fewer than two anchors. */
    bpm: number | null;
    /**
     * Which of the blob's two grids `items` holds: always the second one.
     *
     * Not verified: that "adjusted" is Engine's own name for it. That the
     * second grid is the one Engine plays *is* measured — on 30 of the 281
     * real blobs the two grids differ, and on seven of those the first runs
     * at exactly half `Track.bpmAnalyzed` while the second matches it. The
     * word is the standard one for that role in the reverse-engineering
     * literature, not a string read out of the blob.
     */
    grid: "adjusted";
  }
>;
export type WaveformSummary = { layout: LayoutStatus } & (
  | {
      status: "ok";
      /** How many peak values `profile` holds — one per bucket. */
      peaks: number;
      /** Waveform points the blob carries (1024 in every blob measured). */
      entries: number;
      /** Audio samples each point covers; entries × this is the track length. */
      samples_per_entry: number;
      /** Size of the decompressed waveform blob, in bytes. */
      bytes: number;
      /** Track length in seconds, from Track.length; null when unknown. */
      duration_seconds: number | null;
      profile: number[];
    }
  | { status: "empty" }
  | { status: "unsupported"; detail: string; bytes: number }
  | { status: "corrupt"; detail: string }
);

// Sanity bounds: a corrupt length/count field must be refused rather than
// attempted, however large it claims to be. These are generous compared to
// the real values measured (8 cue slots, 8 loop slots, 2 beat anchors per
// grid, 1024 waveform points), which never come close to them.
//
// These are *parse* bounds, not response bounds — see MAX_RETURNED below.
const MAX_ITEMS = 512; // a real cue or loop list is nowhere near this
const MAX_ANCHORS = 8192; // a real beatgrid is nowhere near this either
const MAX_WAVEFORM_ENTRIES = 1 << 20; // 1024 in every blob measured

/**
 * How many items of a decoded field actually reach the caller. The parse
 * bounds above have to be generous enough to accept anything real; this one
 * exists because the result lands in an LLM's context, and `reply()`
 * serialises it twice (once as text, once as structuredContent). 8192
 * beatgrid anchors — reachable from a single corrupt count — is roughly a
 * megabyte of context spent on numbers nobody asked for. audit_library
 * already answers with a count plus a sample of ten for the same reason.
 */
const MAX_RETURNED = 64;

/** Engine's "this slot is empty" marker, in every cue and loop slot measured. */
const UNSET = -1;

/** Reads a float64 that must be finite; a NaN/Infinity here means the
 * offset landed on the wrong bytes (corrupt data or a wrong layout), not a
 * legitimate value — silently returning NaN would later serialise as `null`
 * in JSON and read as "no value" rather than "decode failed". */
function finiteF64(r: Reader, what: string): number {
  const v = r.f64();
  if (!Number.isFinite(v)) throw new DecodeError(`${what} is not a finite number`);
  return v;
}
function finiteF64le(r: Reader, what: string): number {
  const v = r.f64le();
  if (!Number.isFinite(v)) throw new DecodeError(`${what} is not a finite number`);
  return v;
}

/**
 * A sample rate is only usable for converting sample offsets to seconds if it
 * is a real rate. Anything outside this window is refused rather than used to
 * manufacture a plausible-looking duration.
 */
function usableRate(rate: number | null | undefined): number | null {
  return typeof rate === "number" && Number.isFinite(rate) && rate >= 8000 && rate <= 768000
    ? rate
    : null;
}
function seconds(sampleOffset: number, rate: number | null): number | null {
  if (rate === null) return null;
  const v = Math.round((sampleOffset / rate) * 1000) / 1000;
  // Engine stores some main cues a hair *before* zero (-1.45e-11 samples on
  // one real track), which rounds to negative zero. JSON.stringify turns -0
  // into 0, so leaving it would make the value the server sends over the
  // wire differ from the value it holds — and would make any equality check
  // against a recorded fixture fail for a difference nobody can observe.
  return v === 0 ? 0 : v;
}

/** Reads a count field that a fixed-size allocation or loop depends on. */
function boundedCount(r: Reader, littleEndian: boolean, cap: number, what: string): number {
  const n = littleEndian ? r.i64le() : r.i64();
  if (n < 0 || n > cap) throw new DecodeError(`unsupported ${what} ${n}`);
  return n;
}

/**
 * Envelope keys `guard` owns. A body's extra fields are spread *after* them,
 * so a body that returned one of these would silently overwrite the
 * envelope — a decode reporting `status: "ok"` because the body happened to
 * use that name for something of its own. Declaring them as optional `never`
 * makes it a compile error at the call site instead of a value nobody would
 * test for.
 *
 * The constraint is on the *body's return type*, not only on `X`. Both call
 * sites pass their type arguments explicitly, so `X` is never inferred from
 * the body and constraining `X` alone would let the body return whatever it
 * liked while `X` stayed innocent. Verified by mutation: adding
 * `status: "ok" as const` to decodeLoops' body compiles under the
 * `X`-only constraint and fails under this one.
 *
 * `items` is not in the list: it is destructured out of the body's result
 * before the spread, so it cannot reach `extra` to shadow anything.
 */
type GuardOwned = "layout" | "status" | "total" | "truncated";
type Forbidden = { [K in GuardOwned]?: never };

function guard<T, X extends object & Forbidden>(
  buf: Buffer | null,
  layout: LayoutStatus,
  frame: "qcompress" | "raw",
  body: (r: Reader) => { items: T[] } & X & Forbidden,
): Decoded<T, X> {
  if (!buf || buf.length === 0) return { layout, status: "empty" };
  try {
    // Parsed in full (the buffer has to be walked to be validated at all),
    // returned bounded.
    const { items, ...extra } = body(new Reader(frame === "qcompress" ? qUncompress(buf) : buf));
    return {
      layout,
      status: "ok",
      items: items.slice(0, MAX_RETURNED),
      total: items.length,
      truncated: items.length > MAX_RETURNED,
      ...(extra as unknown as X),
    };
  } catch (e) {
    const detail = (e as Error).message;
    return e instanceof DecodeError && /unsupported|signature/i.test(detail)
      ? { layout, status: "unsupported", detail, bytes: buf.length }
      : { layout, status: "corrupt", detail };
  }
}

/**
 * quickCues — qCompress frame, big-endian, 129 bytes inflated for a track
 * whose cue labels are all empty:
 *
 *   int64  slot count                                     (8 bytes, always 8)
 *   per slot:  uint8 label length, label bytes,
 *              float64 sample offset (-1.0 = slot unused),
 *              4 colour bytes                    (13 bytes with an empty label)
 *   float64 main cue, uint8 main-cue-adjusted flag, float64 default main cue
 *                                                                   (17 bytes)
 *
 * Evidence. 8 + 8×13 + 17 = 129, the size of 278 of the 281 real blobs, and
 * every one parsed to exactly its last byte. The remaining three inflate to
 * 134: 5 bytes longer because one slot carries the 5-character label
 * "Cue 8", which is only consistent with a *variable*-length slot — a
 * fixed-stride layout cannot produce two sizes. The -1.0 sentinel appears at
 * the offset this layout predicts in all 2245 unused slots, so the 13-byte
 * stride is confirmed 2245 times over, not once. The three populated slots
 * decode to 244.94 s of a 300 s track and 0.05 s of a 369 s track — inside
 * the track, which a wrong offset would not be. The main-cue triple's first
 * double distributes as: 122 blobs at the -1.0 sentinel, 51 at exactly 0,
 * 105 at a positive offset inside the track, and 3 slightly negative — two
 * at -1.455e-11 samples and one at -598.8 samples (-0.0136 s), all three
 * within a beat of zero rather than anywhere random, which is what a
 * misaligned read would produce. Its two doubles differ from each other on
 * 25 tracks, which they could not if the layout had merged one field with
 * its neighbour.
 *
 * Not verified: which of the four colour bytes is which channel. Reading
 * them as (alpha, red, green, blue) makes the one slot carrying an unedited
 * Engine default agree with djinterop's `pad_8` constant {0x15, 0x8E, 0xE2}
 * on red and blue but not green, and the alternative reading gives a cue
 * marker 12% opaque, so alpha-first is likely — but "likely" is not
 * measured, and two colours from two tracks cannot settle it. The bytes are
 * therefore reported as stored, as one big-endian u32, with no channel
 * claim attached.
 */
export function decodeCues(buf: Buffer | null, sampleRate?: number | null): CuesResult {
  const rate = usableRate(sampleRate);
  return guard<Cue, { slots: number; main_cue: MainCue }>(buf, LAYOUT_VERIFIED, "qcompress", (r) => {
    const slots = boundedCount(r, false, MAX_ITEMS, `cue slot count`);
    const items: Cue[] = [];
    for (let i = 0; i < slots; i++) {
      // A cue label's length is a single byte, so no cap of ours can be
      // tighter than the 255 it can express. The defence against a length
      // that overruns the blob is Reader's bounds check inside utf8(), which
      // refuses rather than silently returning a short label.
      const label = r.utf8(r.u8());
      const position = finiteF64(r, "cue position");
      const colour = r.u32();
      // An unused slot is not a cue. Reporting eight slots per track, six of
      // them at sample -1, would put fabricated cue points in front of a
      // model that has no way to tell them from real ones.
      if (position === UNSET) continue;
      items.push({
        index: i,
        label,
        position_samples: position,
        position_seconds: seconds(position, rate),
        colour,
      });
    }
    const main = finiteF64(r, "main cue");
    const isAdjusted = r.u8() !== 0;
    const mainDefault = finiteF64(r, "default main cue");
    return {
      items,
      slots,
      main_cue: {
        position_samples: main === UNSET ? null : main,
        position_seconds: main === UNSET ? null : seconds(main, rate),
        default_samples: mainDefault === UNSET ? null : mainDefault,
        is_adjusted: isAdjusted,
      },
    };
  });
}

/**
 * Whether this track actually has a hot cue set — the question "which tracks
 * still need cue points?" is really asking.
 *
 * It exists because the cheap SQL answer is not an answer at all. Engine
 * writes a full eight-slot `quickCues` blob to every analysed track whether
 * or not a pad is used, so `length(quickCues) > 0` is true for all 281 blobs
 * in the reference library while exactly 3 of them (two tracks, one of which
 * is exported to a second library) hold a cue. A check that structurally
 * cannot report a problem is worse than no check: it answers "none of your
 * tracks need cue points" for a library where 255 of 257 do.
 *
 * The main cue is deliberately excluded. It is set on 159 of the 281 blobs,
 * including all 71 tracks the library records as played and 88 that it does
 * not — Engine writes it as a playback start marker, not as something a DJ
 * placed. Counting it would make this flag answer a third question, closer
 * to "has this been loaded on a deck" than to "has a cue been set".
 *
 * A blob that fails to decode answers `false`: an undecodable blob is not
 * evidence that a cue exists, and the direction that errs toward flagging a
 * track for a human to look at is the safe one for an audit.
 */
export function hasCueSet(buf: Buffer | null): boolean {
  const cues = decodeCues(buf, null);
  return cues.status === "ok" && cues.items.length > 0;
}

/**
 * loops — 192 raw bytes, uncompressed and unframed, little-endian:
 *
 *   int64  slot count                                     (8 bytes, always 8)
 *   per slot:  uint8 label length, label bytes,
 *              float64 start, float64 end (-1.0 = slot unused),
 *              uint8 start-set, uint8 end-set, 4 colour bytes
 *                                                (23 bytes with an empty label)
 *
 * Evidence for the framing and the slot grid: 8 + 8×23 = 192, the size of
 * all 281 real blobs, every one of which parsed to exactly its last byte;
 * the little-endian count reads as 8, and the little-endian -1.0 sentinel
 * (`000000000000f0bf`) appears at the offsets this layout predicts in all
 * 2248 slots. Reading the count big-endian gives 134217728, which is what
 * made every real track decode as `unsupported` before.
 *
 * This layout keeps `layout: "unverified"`. Not one of the 2248 slots is
 * populated — this library has no saved loops — so while the slot grid is
 * pinned down by 2248 sentinels, the six bytes after each slot's two doubles
 * are zero everywhere, and nothing here distinguishes start/end from
 * end/start, or fixes the order of the flag and colour bytes. A populated
 * loop is the one thing the available data cannot exercise, so it is not
 * claimed as verified.
 */
export function decodeLoops(buf: Buffer | null, sampleRate?: number | null): LoopsResult {
  const rate = usableRate(sampleRate);
  return guard<Loop, { slots: number }>(buf, LAYOUT_UNVERIFIED, "raw", (r) => {
    const slots = boundedCount(r, true, MAX_ITEMS, `loop slot count`);
    const items: Loop[] = [];
    for (let i = 0; i < slots; i++) {
      const label = r.utf8(r.u8()); // see decodeCues on why there is no cap here
      const start = finiteF64le(r, "loop start");
      const end = finiteF64le(r, "loop end");
      r.skip(6); // start-set flag, end-set flag, four colour bytes
      if (start === UNSET && end === UNSET) continue;
      items.push({
        index: i,
        label,
        start_samples: start,
        end_samples: end,
        start_seconds: seconds(start, rate),
        end_seconds: seconds(end, rate),
      });
    }
    return { items, slots };
  });
}

/**
 * beatData — qCompress frame, 138 bytes inflated on every track measured,
 * and mixed-endian:
 *
 *   float64 BE sample rate
 *   float64 BE sample count
 *   uint8      beat data present
 *   int64   BE default-grid marker count, then that many markers
 *   int64   BE adjusted-grid marker count, then that many markers
 *   9 trailing bytes (zero on every track measured)
 *
 * A marker is 24 bytes and little-endian: float64 sample offset, int64 beat
 * number, int32 beats until the next marker, int32 unknown.
 *
 * Evidence. 17 + 8 + 2×24 + 8 + 2×24 + 9 = 138 for all 281. The two leading
 * doubles read big-endian as 44100 (276 tracks) or 48000 (5); read the other
 * way they are denormals. sample count ÷ sample rate equals `Track.length`
 * to within a second for all 281 — a check on both doubles at once that no
 * other offset or endianness passes. Within a grid, the beat numbers of
 * consecutive markers differ by exactly the preceding marker's "beats until
 * next" field on all 281, which pins the marker stride and three of its four
 * fields simultaneously. The tempo implied by the adjusted grid's first and
 * last anchor matches `Track.bpmAnalyzed` to within 0.5 BPM on all 281 —
 * across tempos from 102 to 170 and durations from 92 s to 602 s, a
 * prediction a wrong offset or a wrong endianness has no way to satisfy.
 *
 * `items` holds the *adjusted* grid, which is what Engine plays. That choice
 * is itself measured, not stylistic: the two grids are byte-identical on 251
 * tracks and differ on 30, and on seven of those the default grid runs at
 * exactly half `bpmAnalyzed` (85.0000 against 170, 80.0000 against 160)
 * while the adjusted grid matches it. The trailing int32 of each marker is
 * read and discarded:
 * it holds 0-12 on first markers and 1 or 2 on last ones, with two tracks
 * carrying values that look like float bit patterns, and nothing in the
 * library explains it. Reporting a field nobody can interpret would be
 * padding a model's context with noise.
 */
export function decodeBeatgrid(buf: Buffer | null): BeatgridResult {
  return guard<
    BeatAnchor,
    {
      sample_rate: number;
      sample_count: number;
      duration_seconds: number;
      bpm: number | null;
      grid: "adjusted";
    }
  >(buf, LAYOUT_VERIFIED, "qcompress", (r) => {
    const sampleRate = finiteF64(r, "sample rate");
    const rate = usableRate(sampleRate);
    if (rate === null) throw new DecodeError(`unsupported sample rate ${sampleRate}`);
    const sampleCount = finiteF64(r, "sample count");
    if (sampleCount < 0) throw new DecodeError(`sample count is negative: ${sampleCount}`);
    r.u8(); // beat data present; 1 on every analysed track measured

    const readGrid = (which: string): BeatAnchor[] => {
      const count = boundedCount(r, false, MAX_ANCHORS, `${which} beatgrid anchor count`);
      const anchors: BeatAnchor[] = [];
      for (let i = 0; i < count; i++) {
        const sample = finiteF64le(r, "beat anchor sample");
        const beat = r.i64le();
        r.i32le(); // beats until the next marker; re-derivable from beat numbers
        r.i32le(); // unknown, see the note above
        anchors.push({ sample, beat, seconds: seconds(sample, rate) });
      }
      return anchors;
    };
    readGrid("default");
    const items = readGrid("adjusted");

    let bpm: number | null = null;
    if (items.length >= 2) {
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const spanSeconds = (last.sample - first.sample) / rate;
      // A zero or backwards span would divide into Infinity or a negative
      // tempo; either is a decode failure dressed as a number.
      if (spanSeconds > 0) {
        const value = ((last.beat - first.beat) / spanSeconds) * 60;
        if (Number.isFinite(value) && value > 0) bpm = Math.round(value * 1000) / 1000;
      }
    }
    return {
      items,
      sample_rate: sampleRate,
      sample_count: sampleCount,
      duration_seconds: Math.round((sampleCount / rate) * 1000) / 1000,
      bpm,
      grid: "adjusted",
    };
  });
}

/**
 * overviewWaveFormData — qCompress frame, big-endian header, 3099 bytes
 * inflated on every track measured:
 *
 *   int64 BE   number of waveform points
 *   int64 BE   the same number again
 *   float64 BE audio samples per point
 *   three bytes per point (three band levels)
 *   three trailing bytes: the maximum of each band over the whole track
 *
 * Evidence. Both counts read 1024 on all 281 blobs, and 24 + 3×1024 + 3 =
 * 3099 accounts for every byte. The overview is a fixed 1024 points
 * regardless of track length, so it is the *spacing* that scales with
 * duration, not the size: samples-per-point × 1024 equals the sample count
 * in `beatData` on all 281 — for a 345-second track that is 14858.0 × 1024 =
 * 15214592 samples, the same value beatData carries. The three trailing
 * bytes equal the per-band maximum computed over the 1024 points on all 281,
 * a prediction with 255³ ways to fail per track that failed on none. That
 * last check is what makes the three-bytes-per-point *stride* measured
 * rather than assumed, and it is why this field carries `layout: "verified"`
 * like cues and the beatgrid.
 *
 * Not verified: that the three bytes per point are the low, mid and high
 * bands, in that order. Three parallel level channels is what the byte
 * evidence shows; naming them is a reading of Engine's own display, and
 * nothing in the library distinguishes one ordering from another. Nothing
 * downstream depends on it — `profile` takes the loudest of the three,
 * which is order-independent — so the naming is kept out of the response
 * rather than asserted in it.
 *
 * The raw waveform is never returned to the model; it is reduced to a coarse
 * per-bucket profile (loudest band value in the bucket, normalised to 0..1).
 * That bucketing now runs over the waveform points rather than over the
 * decompressed bytes, which previously mixed the 24-byte header and the
 * trailing maxima into the first and last buckets.
 *
 * `duration_seconds` still comes from Track.length rather than from the
 * blob: the overview carries a sample *count* but no sample rate, so a
 * duration derived from it alone would be a guess.
 *
 * `buckets` has no caller today that passes anything but the default, so a
 * bad value here is unreachable in practice -- guarded anyway so it stays
 * that way for the next caller rather than becoming a trap. A non-finite or
 * non-positive value (0, negative, NaN, +/-Infinity) falls back to the
 * default instead of reaching the bucket-size arithmetic below: 0 or a
 * negative value there would clamp the *denominator*, not the bucket count,
 * which maximises bucket size and collapses the whole track into one giant
 * bucket -- the opposite of "more buckets"; NaN propagates through to a
 * single bucket reporting a peak of 0 regardless of the actual audio. Both
 * still come back `status: "ok"` -- a confident, wrong answer, not a
 * request this function visibly declined to honour.
 */
export function summariseWaveform(
  buf: Buffer | null,
  buckets = 32,
  durationSeconds: number | null = null,
): WaveformSummary {
  if (!buf || buf.length === 0) return { layout: LAYOUT_VERIFIED, status: "empty" };
  const safeBuckets = Number.isFinite(buckets) && buckets > 0 ? buckets : 32;
  try {
    const data = qUncompress(buf);
    if (data.length === 0) return { layout: LAYOUT_VERIFIED, status: "empty" };
    const r = new Reader(data);
    const entries = boundedCount(r, false, MAX_WAVEFORM_ENTRIES, "waveform point count");
    const entriesAgain = boundedCount(r, false, MAX_WAVEFORM_ENTRIES, "waveform point count");
    if (entries !== entriesAgain) {
      throw new DecodeError(`waveform point counts disagree: ${entries} and ${entriesAgain}`);
    }
    const samplesPerEntry = finiteF64(r, "waveform samples per point");
    // bytes(): bounds-checked, so a count larger than the blob is refused
    // here rather than producing a silently short waveform.
    const points = r.bytes(entries * 3);

    const size = Math.max(1, Math.ceil(entries / safeBuckets));
    const profile: number[] = [];
    for (let i = 0; i < entries; i += size) {
      let peak = 0;
      for (let j = i; j < Math.min(i + size, entries); j++) {
        const at = j * 3;
        peak = Math.max(peak, points[at]!, points[at + 1]!, points[at + 2]!);
      }
      profile.push(Math.round((peak / 255) * 100) / 100);
    }
    return {
      layout: LAYOUT_VERIFIED,
      status: "ok",
      peaks: profile.length,
      entries,
      samples_per_entry: samplesPerEntry,
      bytes: data.length,
      duration_seconds: durationSeconds,
      profile,
    };
  } catch (e) {
    const detail = (e as Error).message;
    return e instanceof DecodeError && /unsupported|signature/i.test(detail)
      ? { layout: LAYOUT_VERIFIED, status: "unsupported", detail, bytes: buf.length }
      : { layout: LAYOUT_VERIFIED, status: "corrupt", detail };
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
 *
 * The one dependency between fields is the sample rate, which only beatData
 * carries and which cue and loop offsets need to become seconds. It is
 * passed in as a value, so a beatData that fails to decode costs the cues
 * their `position_seconds` and nothing else: `position_samples` is still
 * reported, and the cue list still decodes.
 */
export function decodePerformance(row: PerformanceRow): {
  sample_rate: number | null;
  cues: CuesResult;
  loops: LoopsResult;
  beatgrid: BeatgridResult;
  waveform_summary: WaveformSummary;
} {
  const beatgrid = decodeBeatgrid(row.beatData);
  const sampleRate = beatgrid.status === "ok" ? beatgrid.sample_rate : null;
  return {
    sample_rate: sampleRate,
    cues: decodeCues(row.quickCues, sampleRate),
    loops: decodeLoops(row.loops, sampleRate),
    beatgrid,
    waveform_summary: summariseWaveform(row.overviewWaveFormData, 32, row.durationSeconds ?? null),
  };
}
