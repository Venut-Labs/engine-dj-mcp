// tests/blobs.test.ts
//
// Synthetic-input tests for the defensive envelope: truncation, absurd
// counts, non-finite floats, bounded responses, field independence. These
// build their input from the same layout the decoder reads, so they cannot
// prove the layout is right — that is what tests/blobs-golden.test.ts, which
// feeds the decoders bytes copied out of a real Engine library, is for. The
// two suites answer different questions and neither substitutes for the
// other: a decoder that is safe on garbage but wrong on real bytes passes
// this file alone, which is exactly how a decoder that found zero cues in a
// track that has them once passed everything.
import { describe, it, expect } from "vitest";
import { deflateSync } from "node:zlib";
import { qUncompress, Reader } from "../src/blobs/qcompress.js";
import {
  qCompress,
  u8,
  u32,
  i64,
  i64le,
  f64,
  f64le,
  cueFrame,
  emptyCue,
  loopBlob,
  emptyLoop,
  beatFrame,
  waveFrame,
} from "./fixtures/blob-frames.js";
import {
  decodeCues,
  decodeLoops,
  decodeBeatgrid,
  summariseWaveform,
  decodePerformance,
  type Cue,
  type Loop,
} from "../src/blobs/index.js";

describe("qCompress framing", () => {
  it("round-trips a payload", () => {
    const payload = Buffer.from("hello engine", "utf8");
    expect(qUncompress(qCompress(payload)).equals(payload)).toBe(true);
  });

  it("rejects a truncated frame", () => {
    expect(() => qUncompress(Buffer.from([0, 0, 1]))).toThrow();
  });

  it("rejects a length that disagrees with the payload", () => {
    const bad = qCompress(Buffer.from("abc"));
    bad.writeUInt32BE(9999, 0);
    expect(() => qUncompress(bad)).toThrow();
  });

  it("stops inflating at the declared length instead of expanding the whole stream", () => {
    // 64 MiB of zeros compresses to a few dozen kilobytes. Blob decoding runs
    // in the MCP server process, not in the killable query child, so an
    // unbounded inflateSync here is an out-of-memory kill of the entire
    // server -- and the input is not necessarily the user's own file, since
    // defaultRoots() scans /Volumes.
    const bomb = Buffer.concat([u32(16), deflateSync(Buffer.alloc(64 * 1024 * 1024))]);
    expect(bomb.length).toBeLessThan(200_000); // the frame really is small
    const before = process.memoryUsage().heapUsed;
    expect(() => qUncompress(bomb)).toThrow(/zlib/i);
    // A decode that ran to completion would have had to materialise 64 MiB;
    // aborting at the declared 16 bytes cannot.
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(32 * 1024 * 1024);
  });

  it("refuses a declared length beyond any real Engine blob before inflating at all", () => {
    // maxOutputLength: expected alone still trusts four attacker-controlled
    // header bytes, so a ~4 GiB claim would still be honoured.
    const huge = Buffer.concat([u32(0xffffffff), deflateSync(Buffer.alloc(1024))]);
    expect(() => qUncompress(huge)).toThrow(/unsupported uncompressed length/i);
  });
});

describe("Reader bounds checking", () => {
  // Buffer's own readUInt32BE/readDoubleBE already throw natively past the
  // end (verified: RangeError, "Attempt to access memory outside buffer
  // bounds"), so a truncated numeric read is caught with or without Reader's
  // own #need() check — that redundancy is real and is not what this
  // decoder relies on for safety there. Buffer#subarray does NOT throw past
  // the end (it silently clips), so for bytes()/utf8() — used for cue/loop
  // labels — Reader's own bounds check is the only thing standing between a
  // truncated length prefix and a silently short label. These tests exercise
  // Reader directly so that guarantee is proven independent of whichever
  // field happens to follow it in any particular blob layout.
  it("throws reading a fixed-width field past the end", () => {
    expect(() => new Reader(Buffer.from([1, 2, 3])).u32()).toThrow();
    expect(() => new Reader(Buffer.alloc(7)).f64()).toThrow();
    expect(() => new Reader(Buffer.alloc(7)).f64le()).toThrow();
    expect(() => new Reader(Buffer.alloc(7)).i64()).toThrow();
    expect(() => new Reader(Buffer.alloc(7)).i64le()).toThrow();
    expect(() => new Reader(Buffer.alloc(3)).i32le()).toThrow();
  });

  it("succeeds reading a fixed-width field that exactly fits", () => {
    expect(() => new Reader(Buffer.alloc(4)).u32()).not.toThrow();
    expect(() => new Reader(Buffer.alloc(8)).f64()).not.toThrow();
    expect(() => new Reader(Buffer.alloc(8)).i64le()).not.toThrow();
  });

  it("reads each width in the endianness its name promises", () => {
    // The blobs mix orders, so a reader that quietly used one order for both
    // names would decode half the real bytes into nonsense while every
    // synthetic test still passed.
    expect(new Reader(f64(1234.5)).f64()).toBe(1234.5);
    expect(new Reader(f64le(1234.5)).f64le()).toBe(1234.5);
    expect(new Reader(i64(8)).i64()).toBe(8);
    expect(new Reader(i64le(8)).i64le()).toBe(8);
    // Non-vacuous: the two orders really do disagree on these bytes. The
    // little-endian 8 read big-endian is 2^59, which is also the realistic
    // way the safe-range guard fires — reading `loops`' count the wrong way
    // round is exactly this mistake.
    expect(new Reader(f64le(1234.5)).f64()).not.toBe(1234.5);
    expect(() => new Reader(i64le(8)).i64()).toThrow(/safe range/i);
  });

  it("refuses an int64 too large to survive as a Number rather than rounding it", () => {
    const b = Buffer.alloc(8);
    b.writeBigInt64BE(2n ** 62n, 0);
    expect(() => new Reader(b).i64()).toThrow(/safe range/i);
  });

  it("throws rather than silently clipping a variable-length read past the end", () => {
    // Buffer#subarray(0, 10) on a 3-byte buffer would silently return those
    // 3 bytes with no error; Reader must refuse this instead.
    expect(() => new Reader(Buffer.from("abc")).bytes(10)).toThrow();
    expect(() => new Reader(Buffer.from("abc")).utf8(10)).toThrow();
    expect(() => new Reader(Buffer.from("abc")).skip(10)).toThrow();
  });

  it("succeeds reading a variable-length field that exactly fits", () => {
    expect(new Reader(Buffer.from("abc")).utf8(3)).toBe("abc");
  });
});

describe("decoders never throw", () => {
  it("reports empty for null and zero-length input, for every decoder", () => {
    expect(decodeCues(null).status).toBe("empty");
    expect(decodeCues(Buffer.alloc(0)).status).toBe("empty");
    expect(decodeLoops(null).status).toBe("empty");
    expect(decodeLoops(Buffer.alloc(0)).status).toBe("empty");
    expect(decodeBeatgrid(null).status).toBe("empty");
    expect(decodeBeatgrid(Buffer.alloc(0)).status).toBe("empty");
    expect(summariseWaveform(null).status).toBe("empty");
    expect(summariseWaveform(Buffer.alloc(0)).status).toBe("empty");
  });

  it("distinguishes a present-but-empty frame (ok, items: []) from absent data (empty)", () => {
    // A field Engine never wrote is null; a field Engine wrote and confirmed
    // held nothing is a valid frame whose slots are all unused. These must
    // not collapse to the same status, or a model loses the difference
    // between "never analysed" and "analysed, no cues found". Every analysed
    // track in the real library is the second case, so this is the common
    // path, not an edge case.
    const zeroCues = decodeCues(cueFrame(Array(8).fill(emptyCue)));
    expect(zeroCues.status).toBe("ok");
    if (zeroCues.status === "ok") {
      expect(zeroCues.items).toEqual([]);
      expect(zeroCues.slots).toBe(8);
      expect(zeroCues.main_cue.position_samples).toBeNull();
    }
    expect(decodeCues(null).status).toBe("empty");

    const zeroLoops = decodeLoops(loopBlob(Array(8).fill(emptyLoop)));
    expect(zeroLoops.status).toBe("ok");
    if (zeroLoops.status === "ok") {
      expect(zeroLoops.items).toEqual([]);
      expect(zeroLoops.slots).toBe(8);
    }
    expect(decodeLoops(null).status).toBe("empty");
  });

  it("reports corrupt or unsupported for garbage rather than throwing", () => {
    const garbage = Buffer.from([9, 9, 9, 9, 1, 2, 3, 4, 5, 6, 7, 8]);
    for (const fn of [decodeCues, decodeLoops, decodeBeatgrid, summariseWaveform]) {
      const r = fn(garbage);
      expect(["corrupt", "unsupported"]).toContain(r.status);
    }
  });

  it("decodes a quickCues frame, reporting only the slots that hold a cue", () => {
    const slots = [...Array(8)].map(() => ({ ...emptyCue }));
    slots[0] = { label: "Intro", position: 44100 * 12, colour: 0xffffea1f };
    slots[7] = { label: "Cue 8", position: 44100 * 64.5, colour: 0xff1571e2 };
    const r = decodeCues(cueFrame(slots), 44100);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.slots).toBe(8);
    expect(r.total).toBe(2); // six unused slots are not cues
    const [a, b] = r.items as [Cue, Cue];
    expect(a.index).toBe(0);
    expect(a.label).toBe("Intro");
    expect(a.position_samples).toBeCloseTo(44100 * 12, 6);
    expect(a.position_seconds).toBe(12);
    expect(a.colour).toBe(0xffffea1f);
    // The slot number is the pad number, so it must survive the gap.
    expect(b.index).toBe(7);
    expect(b.label).toBe("Cue 8");
    expect(b.position_seconds).toBe(64.5);
  });

  it("reports a cue position in samples even when no sample rate is available", () => {
    const slots = [{ label: "", position: 44100 * 3, colour: 0 }];
    const r = decodeCues(cueFrame(slots));
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.items[0]!.position_samples).toBe(44100 * 3);
    expect(r.items[0]!.position_seconds).toBeNull();
  });

  it("refuses to turn samples into seconds with a sample rate that is not one", () => {
    for (const rate of [0, -44100, 5, NaN, Infinity, 1e9]) {
      const r = decodeCues(cueFrame([{ label: "", position: 1000, colour: 0 }]), rate);
      expect(r.status).toBe("ok");
      if (r.status === "ok") expect(r.items[0]!.position_seconds, `rate ${rate}`).toBeNull();
    }
  });

  it("decodes the main cue, which lives in the quickCues blob rather than its own", () => {
    const r = decodeCues(
      cueFrame(Array(8).fill(emptyCue), { position: 88200, adjusted: 1, fallback: 44100 }),
      44100,
    );
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.main_cue).toEqual({
      position_samples: 88200,
      position_seconds: 2,
      default_samples: 44100,
      is_adjusted: true,
    });
  });

  it("decodes a loops blob without inflating it, since Engine stores it raw", () => {
    const blob = loopBlob([{ label: "Loop 1", start: 44100 * 8, end: 44100 * 16 }]);
    // Non-vacuous: this really is not a qCompress frame, and the old decoder
    // treated it as one — which is why every real track reported unsupported.
    expect(() => qUncompress(blob)).toThrow();
    const r = decodeLoops(blob, 44100);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    const [l] = r.items as [Loop];
    expect(l.index).toBe(0);
    expect(l.label).toBe("Loop 1");
    expect(l.start_samples).toBeCloseTo(44100 * 8, 6);
    expect(l.end_samples).toBeCloseTo(44100 * 16, 6);
    expect(l.start_seconds).toBe(8);
    expect(l.end_seconds).toBe(16);
  });

  it("decodes a beatData frame into anchors, sample rate and an implied tempo", () => {
    const r = decodeBeatgrid(
      beatFrame(
        [
          { sample: -73500, beat: -4 },
          { sample: 15232875, beat: 829 },
        ],
        { rate: 44100, samples: 15214592 },
      ),
    );
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.sample_rate).toBe(44100);
    expect(r.sample_count).toBe(15214592);
    expect(r.duration_seconds).toBeCloseTo(345.0, 1);
    expect(r.bpm).toBeCloseTo(144, 3);
    expect(r.grid).toBe("adjusted");
    expect(r.items).toEqual([
      { sample: -73500, beat: -4, seconds: -1.667 },
      { sample: 15232875, beat: 829, seconds: 345.417 },
    ]);
  });

  it("reports the adjusted grid, not the default one, when the two disagree", () => {
    // Real libraries carry both; Engine plays the adjusted one, and on seven
    // tracks in the reference library the default grid runs at exactly half
    // the analysed tempo while the adjusted grid matches it.
    const blob = beatFrame(
      [
        { sample: 0, beat: 0 },
        { sample: 44100 * 100, beat: 200 },
      ],
      {
        def: [
          { sample: 0, beat: 0 },
          { sample: 44100 * 100, beat: 100 },
        ],
      },
    );
    const r = decodeBeatgrid(blob);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.bpm).toBe(120); // the adjusted grid; the default one implies 60
    expect(r.items[1]!.beat).toBe(200);
  });

  it("refuses a beatData sample rate that is not a real one", () => {
    const bad = beatFrame([{ sample: 0, beat: 0 }], { rate: 3 });
    const r = decodeBeatgrid(bad);
    expect(r.status).toBe("unsupported");
  });

  it("reports a null tempo rather than Infinity when the anchors cannot imply one", () => {
    const r = decodeBeatgrid(
      beatFrame([
        { sample: 1000, beat: 0 },
        { sample: 1000, beat: 8 }, // zero span: 8 beats in no time at all
      ]),
    );
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.bpm).toBeNull();
  });

  it("summarises a waveform frame into a bounded, non-raw profile over its points", () => {
    // Four points, two buckets: profile[i] = max of the six band values in
    // the bucket, over 255.
    const points: [number, number, number][] = [
      [10, 250, 0],
      [5, 255, 0],
      [128, 128, 1],
      [4, 4, 4],
    ];
    const r = summariseWaveform(waveFrame(points, 4096), 2, 372);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.peaks).toBe(2);
    expect(r.peaks).toBe(r.profile.length);
    expect(r.entries).toBe(4);
    expect(r.samples_per_entry).toBe(4096);
    // The spec's waveform_summary is duration + peak count + coarse profile;
    // the duration comes from Track.length, since the blob carries a sample
    // count but no sample rate of its own.
    expect(r.duration_seconds).toBe(372);
    expect(r.profile).toEqual([
      Math.round((255 / 255) * 100) / 100,
      Math.round((128 / 255) * 100) / 100,
    ]);
    // The raw bytes never leave the module; only the coarse profile does.
    expect((r as unknown as Record<string, unknown>).raw).toBeUndefined();
    expect((r as unknown as Record<string, unknown>).points).toBeUndefined();
  });

  it("buckets the waveform over its points, not over the header and trailer", () => {
    // The header is 24 bytes and the trailer three; bucketing over raw bytes
    // used to fold both into the first and last buckets, so a silent track
    // came back with a loud first bucket read out of its own point count.
    const silent: [number, number, number][] = Array.from({ length: 64 }, () => [0, 0, 0]);
    const r = summariseWaveform(waveFrame(silent), 8);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.profile).toEqual(Array(8).fill(0));
  });

  it("falls back to the default bucket count for a non-positive or non-finite buckets, without misbehaving", () => {
    // No caller passes a bad value today, so this is unreachable in
    // practice -- it is about the parameter not being a trap for the next
    // one. Before this guard, 0 or a negative buckets silently collapsed
    // the whole track into one giant bucket (the Math.max(1, buckets)
    // divisor clamped the *denominator* up to 1, which maximises the
    // bucket *size*, the opposite of what a caller asking for more
    // buckets than that would expect); NaN was worse, propagating through
    // the arithmetic to a single bucket reporting a peak of 0 regardless of
    // the actual audio. Both came back `status: "ok"` either way -- a
    // confident, wrong answer, not a visible refusal.
    const points: [number, number, number][] = Array.from({ length: 16 }, (_, i): [number, number, number] => [
      i,
      i,
      i,
    ]);
    const baseline = summariseWaveform(waveFrame(points), 32);
    expect(baseline.status).toBe("ok");
    if (baseline.status !== "ok") return;
    expect(baseline.peaks).toBe(16); // one bucket per point: 16 points < 32 buckets

    // A real, explicit bucket count is still honoured -- the guard must not
    // quietly override every call with the default.
    const explicit = summariseWaveform(waveFrame(points), 4);
    expect(explicit.status).toBe("ok");
    if (explicit.status !== "ok") return;
    expect(explicit.peaks).toBe(4);
    expect(explicit.peaks).not.toBe(baseline.peaks);

    for (const bad of [0, -1, -32, NaN, Infinity, -Infinity]) {
      const r = summariseWaveform(waveFrame(points), bad);
      expect(r.status, `buckets=${bad}`).toBe("ok");
      if (r.status !== "ok") continue;
      // Falls back to the same 32-bucket default as the explicit baseline
      // above, not to some other coincidental clamp.
      expect(r.peaks, `buckets=${bad}`).toBe(baseline.peaks);
      expect(r.profile, `buckets=${bad}`).toEqual(baseline.profile);
    }
  });

  it("reports corrupt when the waveform's two point counts disagree", () => {
    const payload = Buffer.concat([i64(4), i64(5), f64(4096), Buffer.alloc(15)]);
    const r = summariseWaveform(qCompress(payload));
    expect(r.status).toBe("corrupt");
    if (r.status === "corrupt") expect(r.detail).toMatch(/disagree/i);
  });

  it("reports corrupt when the waveform claims more points than it carries", () => {
    const payload = Buffer.concat([i64(4096), i64(4096), f64(1), Buffer.alloc(30)]);
    const r = summariseWaveform(qCompress(payload));
    expect(r.status).toBe("corrupt");
    if (r.status === "corrupt") expect(r.detail).toMatch(/need \d+ bytes/i);
  });

  it("reports corrupt for a frame truncated mid-slot, not a partial result", () => {
    // Valid framing, count says 1 slot, but the buffer ends right after the
    // label — no position/colour bytes follow.
    const label = Buffer.from("Intro", "utf8");
    const payload = Buffer.concat([i64(1), u8(label.length), label]);
    const r = decodeCues(qCompress(payload));
    expect(r.status).toBe("corrupt");
  });

  it("reports corrupt when the decoder's own length header disagrees with its payload", () => {
    const bad = cueFrame([{ label: "X", position: 1, colour: 0 }]);
    bad.writeUInt32BE(9999, 0); // header no longer matches the deflated payload
    const r = decodeCues(bad);
    expect(r.status).toBe("corrupt");
    if (r.status === "corrupt") expect(r.detail).toMatch(/length mismatch/i);
  });

  // These tests deliberately supply enough *structurally valid* trailing data
  // for every claimed item (all-zero items are still well-formed: an empty
  // label, a finite 0.0 offset, colour 0). That makes the sanity cap the
  // *only* thing that can reject them — an absent buffer tail would also be
  // rejected by the bounds checker alone, which would make the test pass
  // whether or not the count cap does anything.
  it("refuses an absurd cue slot count rather than attempting it, with valid data behind it", () => {
    const count = 5000; // over MAX_ITEMS (512)
    const slot = Buffer.concat([u8(0), f64(0), u32(0)]);
    const payload = Buffer.concat([i64(count), ...Array(count).fill(slot), f64(-1), u8(0), f64(-1)]);
    const started = Date.now();
    const r = decodeCues(qCompress(payload));
    expect(Date.now() - started).toBeLessThan(1000);
    expect(r.status).toBe("unsupported");
  });

  it("refuses an absurd loop slot count rather than attempting it, with valid data behind it", () => {
    const count = 5000; // over MAX_ITEMS (512)
    const slot = Buffer.concat([u8(0), f64le(0), f64le(0), Buffer.alloc(6)]);
    const payload = Buffer.concat([i64le(count), ...Array(count).fill(slot)]);
    const r = decodeLoops(payload);
    expect(r.status).toBe("unsupported");
  });

  it("refuses an absurd beatgrid anchor count rather than attempting it, with valid data", () => {
    const count = 10000; // over MAX_ANCHORS (8192)
    const marker = Buffer.alloc(24);
    const payload = Buffer.concat([
      f64(44100),
      f64(44100),
      u8(1),
      i64(count),
      ...Array(count).fill(marker),
    ]);
    const r = decodeBeatgrid(qCompress(payload));
    expect(r.status).toBe("unsupported");
  });

  it("refuses an absurd waveform point count rather than attempting it", () => {
    const count = (1 << 20) + 1; // over MAX_WAVEFORM_ENTRIES
    const payload = Buffer.concat([i64(count), i64(count), f64(1), Buffer.alloc(3 * 64)]);
    const started = Date.now();
    const r = summariseWaveform(qCompress(payload));
    expect(Date.now() - started).toBeLessThan(1000);
    expect(r.status).toBe("unsupported");
  });

  it("refuses a label length that overruns the blob instead of returning a short label", () => {
    // The length is a single byte, so no cap of ours can be tighter than the
    // 255 it can express; the bounds check is the whole defence here.
    const payload = Buffer.concat([i64(1), u8(200), Buffer.from("short", "utf8")]);
    const r = decodeCues(qCompress(payload));
    expect(r.status).toBe("corrupt");
    if (r.status === "corrupt") expect(r.detail).toMatch(/need 200 bytes/i);
  });

  it("rejects a non-finite decoded position instead of surfacing NaN", () => {
    // Label ok, but the position bytes are IEEE754 NaN — as would happen if
    // the offset landed on the wrong field. A bare NaN would later serialise
    // to JSON `null`, indistinguishable from a legitimate missing value.
    const label = Buffer.from("X", "utf8");
    const payload = Buffer.concat([i64(1), u8(label.length), label, f64(NaN), u32(0)]);
    const r = decodeCues(qCompress(payload));
    expect(r.status).toBe("corrupt");
    if (r.status === "corrupt") expect(r.detail).toMatch(/finite/i);
  });

  it("rejects a non-finite loop bound, which is little-endian and would otherwise slip", () => {
    const payload = Buffer.concat([i64le(1), u8(0), f64le(Infinity), f64le(0), Buffer.alloc(6)]);
    const r = decodeLoops(payload);
    expect(r.status).toBe("corrupt");
    if (r.status === "corrupt") expect(r.detail).toMatch(/finite/i);
  });

  it("keeps one field's corruption from affecting its siblings in decodePerformance", () => {
    const r = decodePerformance({
      quickCues: cueFrame([{ label: "Intro", position: 100, colour: 1 }]),
      loops: null,
      beatData: Buffer.from([9, 9, 9, 9, 1, 2, 3, 4]),
      overviewWaveFormData: waveFrame([[1, 2, 3]]),
    });

    expect(r.cues.status).toBe("ok");
    if (r.cues.status === "ok") expect(r.cues.items[0]!.label).toBe("Intro");
    expect(r.loops.status).toBe("empty");
    expect(["corrupt", "unsupported"]).toContain(r.beatgrid.status);
    expect(r.waveform_summary.status).toBe("ok");
  });

  it("costs the cues only their seconds, not their decode, when beatData fails", () => {
    // The sample rate is the one value cues borrow from another field, so a
    // broken beatData must not take the cue list down with it.
    const r = decodePerformance({
      quickCues: cueFrame([{ label: "Intro", position: 44100 * 5, colour: 1 }]),
      loops: loopBlob([{ label: "L", start: 1, end: 2 }]),
      beatData: Buffer.from([9, 9, 9, 9, 1, 2, 3, 4]),
      overviewWaveFormData: null,
    });
    expect(r.sample_rate).toBeNull();
    expect(r.cues.status).toBe("ok");
    if (r.cues.status === "ok") {
      expect(r.cues.items[0]!.position_samples).toBe(44100 * 5);
      expect(r.cues.items[0]!.position_seconds).toBeNull();
    }
    if (r.loops.status === "ok") expect(r.loops.items[0]!.start_seconds).toBeNull();
  });

  it("shares beatData's sample rate with the cue and loop decoders when it decodes", () => {
    const r = decodePerformance({
      quickCues: cueFrame([{ label: "Intro", position: 48000 * 5, colour: 1 }]),
      loops: loopBlob([{ label: "L", start: 48000 * 2, end: 48000 * 4 }]),
      beatData: beatFrame(
        [
          { sample: 0, beat: 0 },
          { sample: 48000 * 60, beat: 120 },
        ],
        { rate: 48000 },
      ),
      overviewWaveFormData: null,
    });
    expect(r.sample_rate).toBe(48000);
    if (r.cues.status === "ok") expect(r.cues.items[0]!.position_seconds).toBe(5);
    if (r.loops.status === "ok") expect(r.loops.items[0]!.end_seconds).toBe(4);
  });
});

describe("bounded responses", () => {
  // The 512/8192 parse caps are sanity bounds on a length field read out of
  // the blob; they are not response bounds. reply() serialises the payload
  // twice, so a blob claiming thousands of items must not be able to spend a
  // megabyte of a model's context.
  it("returns at most 64 cues, with the true total alongside", () => {
    const many = Array.from({ length: 300 }, (_, i) => ({
      label: `cue ${i}`,
      position: i * 1000 + 1,
      colour: i,
    }));
    const r = decodeCues(cueFrame(many));
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.items).toHaveLength(64);
    expect(r.total).toBe(300);
    expect(r.truncated).toBe(true);
    // The prefix, not an arbitrary window: a caller has to know which 64.
    expect(r.items[0]!.label).toBe("cue 0");
    expect(r.items[63]!.label).toBe("cue 63");
  });

  it("returns at most 64 beat anchors, with the true total alongside", () => {
    const many = Array.from({ length: 5000 }, (_, i) => ({ sample: i * 22050, beat: i }));
    const r = decodeBeatgrid(beatFrame(many));
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.items).toHaveLength(64);
    expect(r.total).toBe(5000);
    expect(r.truncated).toBe(true);
  });

  it("keeps the waveform profile at the bucket count regardless of point count", () => {
    const points: [number, number, number][] = Array.from({ length: 1024 }, (_, i) => [
      i % 256,
      0,
      0,
    ]);
    const r = summariseWaveform(waveFrame(points), 32);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.profile).toHaveLength(32);
    expect(r.entries).toBe(1024);
  });

  it("does not claim truncation when everything fits", () => {
    const r = decodeLoops(loopBlob([{ label: "Main", start: 1, end: 2 }]));
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.total).toBe(1);
    expect(r.truncated).toBe(false);
    expect(r.items).toHaveLength(1);
  });
});

describe("layout honesty", () => {
  // The marker now says which way it points. Cues, the beatgrid and the
  // waveform were confirmed against 281 real blobs, so a "verified" field's
  // "ok" is a claim about the values. loops keeps "unverified" because not
  // one of the 2248 loop slots in that library is populated: the slot grid
  // is pinned down, a populated slot is not.
  it("marks cue and beatgrid results verified, whatever their status", () => {
    const results = [
      decodeCues(cueFrame([{ label: "Intro", position: 1, colour: 0 }])), // ok
      decodeCues(null), // empty
      decodeBeatgrid(Buffer.from([0, 0, 0, 1])), // corrupt (frame too short)
      decodeCues(qCompress(i64(99999))), // unsupported slot count
    ];
    for (const r of results) expect(r.layout, JSON.stringify(r)).toBe("verified");
    // Non-vacuous: the set above really does span all four statuses.
    expect(new Set(results.map((r) => r.status))).toEqual(
      new Set(["ok", "empty", "corrupt", "unsupported"]),
    );
  });

  it("keeps loops marked unverified, whatever its status", () => {
    const results = [
      decodeLoops(loopBlob([{ label: "L", start: 1, end: 2 }])), // ok
      decodeLoops(null), // empty
      decodeLoops(Buffer.from([0, 0, 0, 1])), // corrupt (too short for a count)
      decodeLoops(i64le(99999)), // unsupported slot count
    ];
    for (const r of results) expect(r.layout, JSON.stringify(r)).toBe("unverified");
    expect(new Set(results.map((r) => r.status))).toEqual(
      new Set(["ok", "empty", "corrupt", "unsupported"]),
    );
  });

  it("carries each field's own marker through decodePerformance", () => {
    const r = decodePerformance({
      quickCues: cueFrame([{ label: "Intro", position: 100, colour: 1 }]),
      loops: null,
      beatData: null,
      overviewWaveFormData: null,
    });
    expect(r.cues.layout).toBe("verified");
    expect(r.beatgrid.layout).toBe("verified");
    expect(r.loops.layout).toBe("unverified");
  });
});
