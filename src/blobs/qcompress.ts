// src/blobs/qcompress.ts
import { inflateSync } from "node:zlib";

export class DecodeError extends Error {}

/**
 * Hard ceiling on a single decompressed blob, independent of what the frame
 * header claims. The declared length is four attacker-controlled bytes, so
 * bounding inflation by it alone still permits a ~4 GiB claim backed by a
 * few kilobytes of zeros. Engine's largest PerformanceData column
 * (overviewWaveFormData) is on the order of tens of kilobytes, so 32 MiB is
 * far above anything real and far below anything that hurts.
 */
const MAX_UNCOMPRESSED = 32 * 1024 * 1024;

/**
 * Qt's qCompress framing: a 4-byte big-endian uncompressed length followed by
 * a raw zlib stream. Engine stores its performance blobs this way.
 *
 * Inflation is bounded *before* it runs, not checked afterwards. This decode
 * happens in the MCP server process, not in the killable query child, so an
 * unbounded inflateSync turns one crafted blob into an out-of-memory kill of
 * the whole server -- the exact failure the process split exists to prevent.
 * "It is the user's own file" does not hold: defaultRoots() scans /Volumes,
 * so a USB stick prepared by someone else is an ordinary input.
 */
export function qUncompress(buf: Buffer): Buffer {
  if (buf.length < 5) throw new DecodeError(`frame too short: ${buf.length} bytes`);
  const expected = buf.readUInt32BE(0);
  if (expected > MAX_UNCOMPRESSED) {
    throw new DecodeError(`unsupported uncompressed length ${expected}`);
  }
  let out: Buffer;
  try {
    // maxOutputLength stops zlib at the declared size instead of letting it
    // allocate whatever the stream expands to; a payload larger than the
    // header claims aborts here rather than after the fact.
    out = inflateSync(buf.subarray(4), { maxOutputLength: Math.max(expected, 1) });
  } catch (e) {
    throw new DecodeError(`zlib: ${(e as Error).message}`);
  }
  if (out.length !== expected) {
    throw new DecodeError(`length mismatch: header says ${expected}, inflated ${out.length}`);
  }
  return out;
}

/**
 * Sequential reader that fails loudly rather than reading past the end.
 *
 * Engine's PerformanceData is not uniformly big-endian, which is why both
 * widths are offered here rather than one being "the" reader. Measured on a
 * real library (257 tracks on a USB export plus 24 in the local history
 * database): `quickCues`, `beatData` and `overviewWaveFormData` store their
 * scalars big-endian, the whole `loops` blob is little-endian, and inside
 * `beatData` the two grid *counts* are big-endian int64 while the marker
 * structs that follow them are little-endian. A reader that assumed one
 * order would decode roughly half of the real bytes into nonsense.
 */
export class Reader {
  #off = 0;
  constructor(private readonly buf: Buffer) {}
  get offset(): number {
    return this.#off;
  }
  get remaining(): number {
    return this.buf.length - this.#off;
  }
  #need(n: number): void {
    // n is derived from blob content in the variable-length cases, so a
    // negative or non-integer n must not be allowed to slip past as a
    // trivially satisfied bound.
    if (!Number.isSafeInteger(n) || n < 0) throw new DecodeError(`bad read length ${n}`);
    if (this.remaining < n) throw new DecodeError(`need ${n} bytes, ${this.remaining} left`);
  }
  u32(): number {
    this.#need(4);
    const v = this.buf.readUInt32BE(this.#off);
    this.#off += 4;
    return v;
  }
  u8(): number {
    this.#need(1);
    return this.buf.readUInt8(this.#off++);
  }
  f64(): number {
    this.#need(8);
    const v = this.buf.readDoubleBE(this.#off);
    this.#off += 8;
    return v;
  }
  /** Little-endian float64 — the `loops` blob and `beatData`'s grid markers. */
  f64le(): number {
    this.#need(8);
    const v = this.buf.readDoubleLE(this.#off);
    this.#off += 8;
    return v;
  }
  /**
   * Signed 64-bit integer, returned as a Number. Every int64 in these blobs
   * is a count or a beat index, all far inside the safe-integer range; a
   * value outside it is corruption, and is refused here rather than being
   * silently rounded into a plausible-looking count.
   */
  #i64(v: bigint): number {
    const n = Number(v);
    if (!Number.isSafeInteger(n)) throw new DecodeError(`int64 out of safe range: ${v}`);
    return n;
  }
  i64(): number {
    this.#need(8);
    const v = this.#i64(this.buf.readBigInt64BE(this.#off));
    this.#off += 8;
    return v;
  }
  i64le(): number {
    this.#need(8);
    const v = this.#i64(this.buf.readBigInt64LE(this.#off));
    this.#off += 8;
    return v;
  }
  i32le(): number {
    this.#need(4);
    const v = this.buf.readInt32LE(this.#off);
    this.#off += 4;
    return v;
  }
  skip(n: number): void {
    this.#need(n);
    this.#off += n;
  }
  bytes(n: number): Buffer {
    this.#need(n);
    const v = this.buf.subarray(this.#off, this.#off + n);
    this.#off += n;
    return v;
  }
  utf8(n: number): string {
    return this.bytes(n).toString("utf8");
  }
}
