import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { SettingsStore } from "./settingsStore.ts";

function makeStore(): SettingsStore {
  const db = new DatabaseSync(":memory:");
  return new SettingsStore(db);
}

test("getConcurrencyLimit() defaults to 3 when never set", () => {
  const store = makeStore();
  assert.equal(store.getConcurrencyLimit(), 3);
});

test("setConcurrencyLimit() persists and getConcurrencyLimit() returns the new value", () => {
  const store = makeStore();
  store.setConcurrencyLimit(5);
  assert.equal(store.getConcurrencyLimit(), 5);
});

test("setConcurrencyLimit() overwrites a previously set value", () => {
  const store = makeStore();
  store.setConcurrencyLimit(5);
  store.setConcurrencyLimit(2);
  assert.equal(store.getConcurrencyLimit(), 2);
});

test("setConcurrencyLimit() rejects values below 1", () => {
  const store = makeStore();
  assert.throws(() => store.setConcurrencyLimit(0));
  assert.throws(() => store.setConcurrencyLimit(-1));
});

test("setConcurrencyLimit() rejects non-integer values", () => {
  const store = makeStore();
  assert.throws(() => store.setConcurrencyLimit(1.5));
});

test("getTranscodeEnabled() defaults to false when never set", () => {
  const store = makeStore();
  assert.equal(store.getTranscodeEnabled(), false);
});

test("setTranscodeEnabled() persists and getTranscodeEnabled() returns the new value", () => {
  const store = makeStore();
  store.setTranscodeEnabled(true);
  assert.equal(store.getTranscodeEnabled(), true);
  store.setTranscodeEnabled(false);
  assert.equal(store.getTranscodeEnabled(), false);
});

test("getTranscodeConcurrencyLimit() defaults to 1 when never set", () => {
  const store = makeStore();
  assert.equal(store.getTranscodeConcurrencyLimit(), 1);
});

test("setTranscodeConcurrencyLimit() persists and rejects invalid values", () => {
  const store = makeStore();
  store.setTranscodeConcurrencyLimit(4);
  assert.equal(store.getTranscodeConcurrencyLimit(), 4);
  assert.throws(() => store.setTranscodeConcurrencyLimit(0));
  assert.throws(() => store.setTranscodeConcurrencyLimit(1.5));
});

test("getSuggestedFilenameMaxLength() defaults to 80 when never set", () => {
  const store = makeStore();
  assert.equal(store.getSuggestedFilenameMaxLength(), 80);
});

test("setSuggestedFilenameMaxLength() persists a value and round-trips null as 'no cap'", () => {
  const store = makeStore();
  store.setSuggestedFilenameMaxLength(40);
  assert.equal(store.getSuggestedFilenameMaxLength(), 40);
  store.setSuggestedFilenameMaxLength(null);
  assert.equal(store.getSuggestedFilenameMaxLength(), null);
});

test("setSuggestedFilenameMaxLength() rejects values below 10 and non-integers", () => {
  const store = makeStore();
  assert.throws(() => store.setSuggestedFilenameMaxLength(9));
  assert.throws(() => store.setSuggestedFilenameMaxLength(0));
  assert.throws(() => store.setSuggestedFilenameMaxLength(20.5));
});
