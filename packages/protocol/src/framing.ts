/**
 * Chrome native messaging framing.
 *
 * A native messaging message is a 4-byte little-endian unsigned integer length
 * prefix followed by that many bytes of UTF-8 JSON.
 *
 * **The two directions have different limits, and conflating them is a common
 * bug.** Chrome allows up to **1 MB** for a host→browser message but up to
 * **64 MB** for a browser→host message. The outbound cap is therefore the one
 * that matters when reading from the host, while a large request to the host is
 * perfectly legal.
 */

export const NATIVE_LENGTH_PREFIX_BYTES = 4;

/** Chrome rejects host→browser messages larger than 1 MB. */
export const NATIVE_MAX_OUTBOUND_BYTES = 1024 * 1024;

/** Chrome rejects browser→host messages larger than 64 MB. */
export const NATIVE_MAX_INBOUND_BYTES = 64 * 1024 * 1024;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: false });

/** Serialises one message into a length-prefixed frame. */
export function encodeNativeMessage(message: unknown): Uint8Array {
  const json = JSON.stringify(message);
  if (json === undefined) {
    throw new TypeError("Native message is not JSON-serialisable");
  }
  const payload = textEncoder.encode(json);
  if (payload.byteLength > NATIVE_MAX_INBOUND_BYTES) {
    throw new RangeError(
      `Native message is ${payload.byteLength} bytes, over the ${NATIVE_MAX_INBOUND_BYTES}-byte limit`,
    );
  }
  const frame = new Uint8Array(NATIVE_LENGTH_PREFIX_BYTES + payload.byteLength);
  new DataView(frame.buffer).setUint32(0, payload.byteLength, true);
  frame.set(payload, NATIVE_LENGTH_PREFIX_BYTES);
  return frame;
}

/**
 * Incremental decoder for the host's stdout stream.
 *
 * Chunks arrive on arbitrary boundaries, so the decoder keeps a partial frame
 * buffered until the rest of it shows up.
 */
export class NativeMessageDecoder {
  #buffer: Uint8Array = new Uint8Array(0);

  /** Feeds a chunk and returns every message that became complete. */
  push(chunk: Uint8Array): unknown[] {
    if (chunk.byteLength === 0) return [];

    const merged = new Uint8Array(this.#buffer.byteLength + chunk.byteLength);
    merged.set(this.#buffer, 0);
    merged.set(chunk, this.#buffer.byteLength);
    this.#buffer = merged;

    const messages: unknown[] = [];
    let offset = 0;

    while (this.#buffer.byteLength - offset >= NATIVE_LENGTH_PREFIX_BYTES) {
      const view = new DataView(
        this.#buffer.buffer,
        this.#buffer.byteOffset + offset,
        NATIVE_LENGTH_PREFIX_BYTES,
      );
      const length = view.getUint32(0, true);

      if (length > NATIVE_MAX_OUTBOUND_BYTES) {
        throw new RangeError(
          `Native message declares ${length} bytes, over the ${NATIVE_MAX_OUTBOUND_BYTES}-byte host→browser limit`,
        );
      }
      const frameEnd = offset + NATIVE_LENGTH_PREFIX_BYTES + length;
      if (this.#buffer.byteLength < frameEnd) break;

      const payload = this.#buffer.subarray(offset + NATIVE_LENGTH_PREFIX_BYTES, frameEnd);
      messages.push(JSON.parse(textDecoder.decode(payload)));
      offset = frameEnd;
    }

    if (offset > 0) this.#buffer = this.#buffer.slice(offset);
    return messages;
  }

  /** Bytes held back waiting for the remainder of an incomplete frame. */
  get pendingBytes(): number {
    return this.#buffer.byteLength;
  }
}
