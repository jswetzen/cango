/**
 * Length-prefixed framing: 4-byte big-endian uint32 length, then that many
 * bytes of UTF-8 JSON. A small stateful decoder reassembles frames from
 * arbitrary chunk boundaries.
 *
 * Uses Uint8Array/DataView directly rather than Node Buffer to avoid the
 * @types/node vs Bun Buffer/Uint8Array iterator-variance clash under
 * lib ES2022.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeFrame(payload: unknown): Uint8Array {
  const json = encoder.encode(JSON.stringify(payload));
  const frame = new Uint8Array(4 + json.length);
  new DataView(frame.buffer).setUint32(0, json.length, false);
  frame.set(json, 4);
  return frame;
}

export class FrameDecoder {
  private buffer = new Uint8Array(0);
  private readonly maxFrameBytes: number;

  constructor(maxFrameBytes = 16 * 1024 * 1024) {
    this.maxFrameBytes = maxFrameBytes;
  }

  /** Append a chunk; return any complete frames as parsed JSON values. */
  push(chunk: Uint8Array): unknown[] {
    this.buffer = concat(this.buffer, chunk);
    const out: unknown[] = [];
    while (this.buffer.length >= 4) {
      const len = new DataView(
        this.buffer.buffer,
        this.buffer.byteOffset,
        4,
      ).getUint32(0, false);
      if (len > this.maxFrameBytes) {
        throw new Error(`frame too large: ${len} bytes`);
      }
      if (this.buffer.length < 4 + len) break;
      const body = this.buffer.subarray(4, 4 + len);
      out.push(JSON.parse(decoder.decode(body)));
      this.buffer = this.buffer.subarray(4 + len);
    }
    return out;
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
