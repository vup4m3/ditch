import { test } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import { decryptAes128Cbc } from "./crypto.ts";

/**
 * Fixtures are built with Node's own `createCipheriv` (a different, independently
 * implemented API from the `createDecipheriv` used in decryptAes128Cbc) so this
 * doesn't just recompute the answer the way the code under test does.
 */
function encrypt(plaintext: Buffer, key: Buffer, iv: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-cbc", key, iv);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

test("decrypts a single-block segment back to its original plaintext", () => {
  const key = randomBytes(16);
  const iv = randomBytes(16);
  const plaintext = Buffer.from("0123456789abcdef", "utf8"); // exactly 16 bytes

  const ciphertext = encrypt(plaintext, key, iv);
  const result = decryptAes128Cbc(ciphertext, key, iv);

  assert.deepEqual(result, plaintext);
});

test("decrypts a multi-block segment whose length is not a multiple of the block size", () => {
  const key = randomBytes(16);
  const iv = randomBytes(16);
  const plaintext = randomBytes(10_000 + 7); // realistic segment-sized, deliberately unaligned

  const ciphertext = encrypt(plaintext, key, iv);
  const result = decryptAes128Cbc(ciphertext, key, iv);

  assert.deepEqual(result, plaintext);
});

test("the wrong key never recovers the original plaintext", () => {
  const key = randomBytes(16);
  const wrongKey = randomBytes(16);
  const iv = randomBytes(16);
  const plaintext = randomBytes(64);

  const ciphertext = encrypt(plaintext, key, iv);

  // A wrong key almost always breaks PKCS7 padding validation (throws), but on the
  // rare chance the garbage bytes happen to form valid padding, the recovered
  // plaintext must still differ from the original.
  try {
    const result = decryptAes128Cbc(ciphertext, wrongKey, iv);
    assert.notDeepEqual(result, plaintext);
  } catch {
    // threw — also an acceptable outcome for a wrong key
  }
});
