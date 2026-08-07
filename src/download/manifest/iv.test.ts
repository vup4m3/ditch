import { test } from "node:test";
import assert from "node:assert/strict";
import { sequenceNumberToIv, uint32ArrayToBufferBE } from "./iv.ts";

test("uint32ArrayToBufferBE preserves big-endian byte order per word", () => {
  const iv = new Uint32Array([0, 0, 0, 1]);
  const buf = uint32ArrayToBufferBE(iv);

  const expected = Buffer.alloc(16);
  expected.writeUInt32BE(0, 0);
  expected.writeUInt32BE(0, 4);
  expected.writeUInt32BE(0, 8);
  expected.writeUInt32BE(1, 12);

  assert.equal(buf.length, 16);
  assert.deepEqual(buf, expected);
});

test("uint32ArrayToBufferBE round-trips a non-trivial IV", () => {
  const iv = new Uint32Array([0xdeadbeef, 0x00000000, 0x12345678, 0x0000000f]);
  const buf = uint32ArrayToBufferBE(iv);

  const expected = Buffer.alloc(16);
  expected.writeUInt32BE(0xdeadbeef, 0);
  expected.writeUInt32BE(0x00000000, 4);
  expected.writeUInt32BE(0x12345678, 8);
  expected.writeUInt32BE(0x0000000f, 12);

  assert.deepEqual(buf, expected);
});

test("sequenceNumberToIv writes the sequence number into the low 32 bits, big-endian", () => {
  const buf = sequenceNumberToIv(1);

  const expected = Buffer.alloc(16);
  expected.writeUInt32BE(1, 12);

  assert.equal(buf.length, 16);
  assert.deepEqual(buf, expected);
});

test("sequenceNumberToIv handles larger sequence numbers", () => {
  const buf = sequenceNumberToIv(0x1a2b3c4d);

  const expected = Buffer.alloc(16);
  expected.writeUInt32BE(0x1a2b3c4d, 12);

  assert.deepEqual(buf, expected);
});
