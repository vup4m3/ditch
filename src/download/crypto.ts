import { createDecipheriv } from "node:crypto";

/**
 * Decrypts an HLS AES-128 segment (AES-128-CBC, PKCS7-padded) — the Node `crypto`
 * equivalent of the reference extension's `crypto.subtle.decrypt` usage (ADR-0002).
 */
export function decryptAes128Cbc(ciphertext: Buffer, key: Buffer, iv: Buffer): Buffer {
  const decipher = createDecipheriv("aes-128-cbc", key, iv);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
