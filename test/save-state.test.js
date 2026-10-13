import assert from "node:assert/strict";
import test from "node:test";
import { createSaveLibrary, loadState, saveState } from "../src/save-state.js";

test("loading a save slot that has no snapshot fails", () => {
  const library = createSaveLibrary();
  const missing = loadState(library, 7, 1);
  assert.equal(missing.ok, false);
  assert.equal(missing.error, "No save in that slot.");
  assert.equal("bytes" in missing, false);

  const saved = saveState(library, 7, 1, new Uint8Array([1, 2, 3]));
  assert.equal(saved.ok, true);

  const otherSlot = loadState(library, 7, 2);
  assert.equal(otherSlot.ok, false);
  assert.equal(otherSlot.error, "No save in that slot.");
  assert.equal("bytes" in otherSlot, false);

  const otherGame = loadState(library, 8, 1);
  assert.equal(otherGame.ok, false);
  assert.equal(otherGame.error, "No save in that slot.");

  const present = loadState(library, 7, 1);
  assert.equal(present.ok, true);
  assert.deepEqual([...present.bytes], [1, 2, 3]);
});

test("saving twice to the same slot keeps one snapshot and the latest bytes", () => {
  const library = createSaveLibrary();
  const firstBytes = new Uint8Array([1, 2, 3]);
  const first = saveState(library, 7, 1, firstBytes);
  assert.equal(first.ok, true);
  assert.equal(first.replaced, false);

  firstBytes[0] = 9;
  assert.deepEqual([...loadState(library, 7, 1).bytes], [1, 2, 3]);

  const secondBytes = new Uint8Array([4, 5]);
  const second = saveState(library, 7, 1, secondBytes);
  assert.equal(second.ok, true);
  assert.equal(second.replaced, true);
  secondBytes[0] = 0;

  const loaded = loadState(library, 7, 1);
  assert.equal(loaded.ok, true);
  assert.deepEqual([...loaded.bytes], [4, 5]);
  loaded.bytes[0] = 0;
  assert.deepEqual([...loadState(library, 7, 1).bytes], [4, 5]);

  assert.equal(loadState(library, 7, 2).ok, false);
  assert.equal(library.games.get(7).size, 1);
});
