/**
 * m3u8-parser exposes EXT-X-KEY's IV as a Uint32Array of four big-endian 32-bit words
 * (per the HLS hex literal). Reading its underlying ArrayBuffer directly would use the
 * platform's native endianness, which is wrong on little-endian hosts — so each word is
 * written out explicitly instead.
 */
export function uint32ArrayToBufferBE(words: Uint32Array): Buffer {
  const buf = Buffer.alloc(16);
  for (let i = 0; i < 4; i++) {
    buf.writeUInt32BE(words[i] ?? 0, i * 4);
  }
  return buf;
}

/**
 * HLS default IV (no explicit IV attribute on EXT-X-KEY): the segment's absolute media
 * sequence number, treated as a 128-bit unsigned integer with the sequence number in the
 * low 32 bits.
 */
export function sequenceNumberToIv(sequenceNumber: number): Buffer {
  const buf = Buffer.alloc(16);
  buf.writeUInt32BE(sequenceNumber >>> 0, 12);
  return buf;
}
