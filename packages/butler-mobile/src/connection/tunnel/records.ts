import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { concat, EMPTY, utf8 } from "./bytes";

export const MAX_RECORD = 65_552;
export const BODY_CHUNK = 65_536;
const END = utf8("end");

export function frame(record: Uint8Array): Uint8Array {
  if (record.length < 1 || record.length > MAX_RECORD) throw new Error("tunnel_protocol");
  const out = new Uint8Array(4 + record.length);
  new DataView(out.buffer).setUint32(0, record.length, false);
  out.set(record, 4);
  return out;
}

/** Reassembles `[u32 BE len][bytes]` records from arbitrary byte chunks. */
export class RecordDecoder {
  private buffer: Uint8Array = EMPTY;
  push(bytes: Uint8Array): Uint8Array[] {
    this.buffer = concat(this.buffer, bytes);
    const out: Uint8Array[] = [];
    let offset = 0;
    while (this.buffer.length - offset >= 4) {
      const length = new DataView(this.buffer.buffer, this.buffer.byteOffset + offset, 4).getUint32(0, false);
      if (length < 1 || length > MAX_RECORD) throw new Error("tunnel_protocol");
      const end = offset + 4 + length;
      if (this.buffer.length < end) break;
      out.push(this.buffer.subarray(offset + 4, end));
      offset = end;
    }
    if (offset > 0) this.buffer = this.buffer.slice(offset);
    return out;
  }
}

/** Body nonce: 4 zero bytes, then the counter as u64 big-endian. */
export function bodyNonce(counter: number): Uint8Array {
  const out = new Uint8Array(12), view = new DataView(out.buffer);
  view.setUint32(4, Math.floor(counter / 2 ** 32), false);
  view.setUint32(8, counter >>> 0, false);
  return out;
}

/** Request body as sealed chunks (≤ 64 KiB plaintext each; the last one has AAD "end"; an empty body is one empty "end" chunk). */
export function sealBody(key: Uint8Array, body: Uint8Array): Uint8Array[] {
  const count = Math.max(1, Math.ceil(body.length / BODY_CHUNK));
  const out: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const piece = body.subarray(i * BODY_CHUNK, (i + 1) * BODY_CHUNK);
    out.push(chacha20poly1305(key, bodyNonce(i), i === count - 1 ? END : EMPTY).encrypt(piece));
  }
  return out;
}
