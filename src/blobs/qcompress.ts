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

/** Sequential big-endian reader that fails loudly rather than reading past the end. */
export class Reader {
  #off = 0;
  constructor(private readonly buf: Buffer) {}
  get remaining(): number {
    return this.buf.length - this.#off;
  }
  #need(n: number): void {
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
