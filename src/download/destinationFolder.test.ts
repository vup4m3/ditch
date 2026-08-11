import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeDestinationFolder, sanitizeFolderName } from "./destinationFolder.ts";

test("sanitizeDestinationFolder: empty/missing input means the root", () => {
  assert.equal(sanitizeDestinationFolder(""), "");
  assert.equal(sanitizeDestinationFolder(undefined), "");
  assert.equal(sanitizeDestinationFolder(null), "");
});

test("sanitizeDestinationFolder: joins clean nested segments with /", () => {
  assert.equal(sanitizeDestinationFolder("電影/2024/暑假"), "電影/2024/暑假");
});

test("sanitizeDestinationFolder: trims whitespace and drops empty segments (e.g. leading/trailing/double slashes)", () => {
  assert.equal(sanitizeDestinationFolder("/電影//2024/ "), "電影/2024");
});

test("sanitizeDestinationFolder: rejects .. traversal", () => {
  assert.throws(() => sanitizeDestinationFolder("電影/../../etc"), /invalid destination folder segment/);
});

test("sanitizeDestinationFolder: rejects a bare .", () => {
  assert.throws(() => sanitizeDestinationFolder("./電影"), /invalid destination folder segment/);
});

test("sanitizeFolderName: accepts a plain name", () => {
  assert.equal(sanitizeFolderName(" 電影 "), "電影");
});

test("sanitizeFolderName: rejects empty, ., .., and names containing a path separator", () => {
  assert.throws(() => sanitizeFolderName(""));
  assert.throws(() => sanitizeFolderName("."));
  assert.throws(() => sanitizeFolderName(".."));
  assert.throws(() => sanitizeFolderName("電影/2024"));
  assert.throws(() => sanitizeFolderName("電影\\2024"));
});
