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
