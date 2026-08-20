// tests/blobs.test.ts
import { describe, it, expect } from "vitest";
import { deflateSync } from "node:zlib";
import { qUncompress, Reader } from "../src/blobs/qcompress.js";
import {
  decodeCues,
  decodeLoops,
  decodeBeatgrid,
  summariseWaveform,
  decodePerformance,
  type Cue,
  type Loop,
} from "../src/blobs/index.js";

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
  });

  it("succeeds reading a fixed-width field that exactly fits", () => {
    expect(() => new Reader(Buffer.alloc(4)).u32()).not.toThrow();
    expect(() => new Reader(Buffer.alloc(8)).f64()).not.toThrow();
  });

  it("throws rather than silently clipping a variable-length read past the end", () => {
    // Buffer#subarray(0, 10) on a 3-byte buffer would silently return those
    // 3 bytes with no error; Reader must refuse this instead.
    expect(() => new Reader(Buffer.from("abc")).bytes(10)).toThrow();
    expect(() => new Reader(Buffer.from("abc")).utf8(10)).toThrow();
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

  it("distinguishes a present-but-zero-count frame (ok, items: []) from absent data (empty)", () => {
    // A field Engine never wrote is null; a field Engine wrote and confirmed
    // held nothing is a valid frame whose count is 0. These must not collapse
    // to the same status, or a model loses the difference between "never
    // analysed" and "analysed, no cues found".
    const zeroCues = decodeCues(cueFrame([]));
    expect(zeroCues.status).toBe("ok");
    if (zeroCues.status === "ok") expect(zeroCues.items).toEqual([]);
    expect(decodeCues(null).status).toBe("empty");

    const zeroLoops = decodeLoops(loopFrame([]));
    expect(zeroLoops.status).toBe("ok");
    if (zeroLoops.status === "ok") expect(zeroLoops.items).toEqual([]);
    expect(decodeLoops(null).status).toBe("empty");
  });

  it("reports corrupt or unsupported for garbage rather than throwing", () => {
    const garbage = Buffer.from([9, 9, 9, 9, 1, 2, 3, 4, 5, 6, 7, 8]);
    for (const fn of [decodeCues, decodeLoops, decodeBeatgrid, summariseWaveform]) {
      const r = fn(garbage);
      expect(["corrupt", "unsupported"]).toContain(r.status);
    }
  });

  it("decodes a well-formed quickCues frame, including a second cue and colour", () => {
    const r = decodeCues(
      cueFrame([
        { label: "Intro", position: 44100 * 12, colour: 0xff3366 },
        { label: "Drop", position: 44100 * 64.5, colour: 0x00ff00 },
      ]),
    );
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    const [a, b] = r.items as [Cue, Cue];
    expect(a.index).toBe(0);
    expect(a.label).toBe("Intro");
    expect(a.position_samples).toBeCloseTo(44100 * 12, 6);
    expect(a.colour).toBe(0xff3366);
    expect(b.index).toBe(1);
    expect(b.label).toBe("Drop");
    expect(b.position_samples).toBeCloseTo(44100 * 64.5, 6);
    expect(b.colour).toBe(0x00ff00);
  });

  it("decodes a well-formed loops frame", () => {
    const r = decodeLoops(
      loopFrame([{ label: "Loop 1", start: 44100 * 8, end: 44100 * 16 }]),
    );
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    const [l] = r.items as [Loop];
    expect(l.index).toBe(0);
    expect(l.label).toBe("Loop 1");
    expect(l.start_samples).toBeCloseTo(44100 * 8, 6);
    expect(l.end_samples).toBeCloseTo(44100 * 16, 6);
  });

  it("decodes a well-formed beatgrid frame", () => {
    const r = decodeBeatgrid(
      beatgridFrame([
        { sample: 0, beat: 1 },
        { sample: 44100 / 2, beat: 2 },
      ]),
    );
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.items).toEqual([
      { sample: 0, beat: 1 },
      { sample: 44100 / 2, beat: 2 },
    ]);
  });

  it("summarises a well-formed waveform frame into a bounded, non-raw profile", () => {
    // 8 raw bytes, bucket size 2 (buckets=4): profile[i] = max(bytes[2i],bytes[2i+1])/255
    const raw = Buffer.from([10, 250, 0, 5, 255, 0, 128, 128]);
    const r = summariseWaveform(qCompress(raw), 4);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.peaks).toBe(8);
    expect(r.profile).toEqual([
      Math.round((250 / 255) * 100) / 100,
      Math.round((5 / 255) * 100) / 100,
      Math.round((255 / 255) * 100) / 100,
      Math.round((128 / 255) * 100) / 100,
    ]);
    // The raw bytes never leave the module; only the coarse profile does.
    expect((r as any).raw).toBeUndefined();
    expect((r as any).data).toBeUndefined();
  });

  it("reports corrupt for a frame truncated mid-item, not a partial result", () => {
    // Valid framing, count says 1 cue, but the buffer ends right after the label
    // — no position/colour bytes follow.
    const label = Buffer.from("Intro", "utf8");
    const payload = Buffer.concat([u32(1), u32(label.length), label]);
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

  // These three tests deliberately supply enough *structurally valid* trailing
  // data for every claimed item (all-zero items are still well-formed: an
  // empty label, a finite 0.0 position/start/end/sample/beat, colour 0). That
  // makes the sanity cap the *only* thing that can reject them — an absent
  // buffer tail would also be rejected by the bounds checker alone, which
  // would make the test pass whether or not the count cap does anything.
  // Verified by execution (see task-14-report.md): removing the cap makes
  // each of these decode successfully instead of being refused.
  it("refuses an absurd cue count rather than attempting it, even with valid-shaped data behind it", () => {
    const count = 5000; // over MAX_ITEMS (512)
    const zeroItem = Buffer.concat([u32(0), f64(0), u32(0)]); // len=0,label="",pos=0,colour=0
    const payload = Buffer.concat([u32(count), ...Array(count).fill(zeroItem)]);
    const started = Date.now();
    const r = decodeCues(qCompress(payload));
    expect(Date.now() - started).toBeLessThan(1000);
    expect(r.status).toBe("unsupported");
  });

  it("refuses an absurd loop count rather than attempting it, even with valid-shaped data behind it", () => {
    const count = 5000; // over MAX_ITEMS (512)
    const zeroItem = Buffer.concat([u32(0), f64(0), f64(0)]); // len=0,label="",start=0,end=0
    const payload = Buffer.concat([u32(count), ...Array(count).fill(zeroItem)]);
    const r = decodeLoops(qCompress(payload));
    expect(r.status).toBe("unsupported");
  });

  it("refuses an absurd beatgrid anchor count rather than attempting it, even with valid-shaped data behind it", () => {
    const count = 10000; // over MAX_ANCHORS (8192)
    const zeroItem = Buffer.concat([f64(0), f64(0)]); // sample=0,beat=0
    const payload = Buffer.concat([u32(count), ...Array(count).fill(zeroItem)]);
    const r = decodeBeatgrid(qCompress(payload));
    expect(r.status).toBe("unsupported");
  });

  it("refuses an absurd label length rather than attempting it, even with the bytes actually present", () => {
    const hugeLabel = Buffer.alloc(5_000_000, 0x41); // over MAX_LABEL_LEN (4096), but really there
    const payload = Buffer.concat([u32(1), u32(hugeLabel.length), hugeLabel, f64(1), u32(0)]);
    const r = decodeCues(qCompress(payload));
    expect(r.status).toBe("unsupported");
  });

  it("rejects a non-finite decoded position instead of surfacing NaN", () => {
    // Label ok, but the position bytes are IEEE754 NaN — as would happen if
    // the offset landed on the wrong field. A bare NaN would later serialise
    // to JSON `null`, indistinguishable from a legitimate missing value.
    const label = Buffer.from("X", "utf8");
    const payload = Buffer.concat([u32(1), u32(label.length), label, f64(NaN), u32(0)]);
    const r = decodeCues(qCompress(payload));
    expect(r.status).toBe("corrupt");
    if (r.status === "corrupt") expect(r.detail).toMatch(/finite/i);
  });

  it("keeps one field's corruption from affecting its siblings in decodePerformance", () => {
    const cues = cueFrame([{ label: "Intro", position: 100, colour: 1 }]);
    const garbageBeatgrid = Buffer.from([9, 9, 9, 9, 1, 2, 3, 4]);
    const waveform = qCompress(Buffer.from([1, 2, 3, 4]));

    const r = decodePerformance({
      quickCues: cues,
      loops: null,
      beatData: garbageBeatgrid,
      overviewWaveFormData: waveform,
    });

    expect(r.cues.status).toBe("ok");
    if (r.cues.status === "ok") expect(r.cues.items[0]!.label).toBe("Intro");
    expect(r.loops.status).toBe("empty");
    expect(["corrupt", "unsupported"]).toContain(r.beatgrid.status);
    expect(r.waveform_summary.status).toBe("ok");
  });
});
