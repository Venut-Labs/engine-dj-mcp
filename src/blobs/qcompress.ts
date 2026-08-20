// src/blobs/qcompress.ts
import { inflateSync } from "node:zlib";

export class DecodeError extends Error {}

/**
 * Qt's qCompress framing: a 4-byte big-endian uncompressed length followed by
 * a raw zlib stream. Engine stores its performance blobs this way.
 */
export function qUncompress(buf: Buffer): Buffer {
  if (buf.length < 5) throw new DecodeError(`frame too short: ${buf.length} bytes`);
  const expected = buf.readUInt32BE(0);
  let out: Buffer;
  try {
    out = inflateSync(buf.subarray(4));
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
