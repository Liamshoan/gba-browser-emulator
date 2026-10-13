import assert from "node:assert/strict";
import test from "node:test";
import { decodeSaveBytes, encodeSaveBytes, saveRecordKey } from "../src/browser-storage.js";
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
});

test("a save roundtrip returns the byte view and not the bytes outside it", () => {
  const library = createSaveLibrary();
  const raw = new Uint8Array([9, 4, 5, 6, 8]);
  const view = raw.subarray(1, 4);
  const saved = saveState(library, 3, 9, view);
  assert.equal(saved.ok, true);
  assert.equal(saved.slot, 9);
  assert.equal(saved.replaced, false);

  const loaded = loadState(library, 3, 9);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.bytes.length, 3);
  assert.deepEqual([...loaded.bytes], [4, 5, 6]);
  loaded.bytes[0] = 0;
  raw[1] = 0;
  assert.deepEqual([...loadState(library, 3, 9).bytes], [4, 5, 6]);
  assert.equal(loadState(library, 3, 1).ok, false);
});

test("slot 0, slot 10, and a missing game id do not roundtrip", () => {
  const library = createSaveLibrary();
  const bytes = new Uint8Array([1]);
  for (const slot of [0, 10, -1, 1.5]) {
    const saved = saveState(library, 2, slot, bytes);
    assert.equal(saved.ok, false, String(slot));
    assert.equal(saved.error, "That save slot does not exist.");
    assert.equal(loadState(library, 2, slot).error, "That save slot does not exist.");
  }
  assert.equal(saveState(library, 0, 1, bytes).error, "Cannot save without a game id.");
  assert.equal(loadState(library, 0, 1).error, "Cannot load without a game id.");
  assert.equal(loadState(library, 2, 1).ok, false);
});

test("a rejected payload leaves the previous snapshot in that slot", () => {
  const library = createSaveLibrary();
  assert.equal(saveState(library, 7, 1, new Uint8Array([1, 2, 3])).ok, true);
  const failed = saveState(library, 7, 1, new Uint8Array([1, 2, 3]).buffer);
  assert.equal(failed.ok, false);
  assert.equal(failed.error, "Cannot save that state.");
  assert.equal("bytes" in failed, false);
  assert.deepEqual([...loadState(library, 7, 1).bytes], [1, 2, 3]);
});

test("a truncated empty snapshot does not replace a stored save", () => {
  const library = createSaveLibrary();
  assert.equal(saveState(library, 7, 1, new Uint8Array([1, 2, 3])).ok, true);
  const failed = saveState(library, 7, 1, new Uint8Array());
  assert.equal(failed.ok, false);
  assert.equal(failed.error, "Cannot save that state.");
  assert.equal("bytes" in failed, false);
  assert.deepEqual([...loadState(library, 7, 1).bytes], [1, 2, 3]);
});

test("a detached snapshot does not replace a stored save", () => {
  const library = createSaveLibrary();
  assert.equal(saveState(library, 4, 2, new Uint8Array([8])).ok, true);
  const bytes = new Uint8Array([1, 2, 3, 4]);
  structuredClone(bytes, { transfer: [bytes.buffer] });
  const failed = saveState(library, 4, 2, bytes);
  assert.equal(failed.ok, false);
  assert.equal(failed.error, "Cannot save that state.");
  assert.deepEqual([...loadState(library, 4, 2).bytes], [8]);
});

function quotaError() {
  const error = new Error("quota");
  error.name = "QuotaExceededError";
  return error;
}

function memoryStorage(map = new Map()) {
  return {
    setItem(key, value) {
      map.set(key, value);
    },
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    removeItem(key) {
      map.delete(key);
    },
  };
}

test("commitSave roundtrips a snapshot through storage", async () => {
  const { commitSave } = await import("../src/save-state.js");
  assert.equal(typeof commitSave, "function");
  const library = createSaveLibrary();
  const map = new Map();
  const bytes = new Uint8Array([4, 5, 6]);
  const saved = commitSave(library, 9, 1, bytes, memoryStorage(map));
  assert.equal(saved.ok, true);
  assert.equal(saved.replaced, false);
  assert.deepEqual([...saved.bytes], [4, 5, 6]);
  bytes[0] = 0;
  assert.deepEqual([...loadState(library, 9, 1).bytes], [4, 5, 6]);
  assert.deepEqual([...map.keys()], ["gba-rom-session:9:1"]);
});

test("commitSave rolls back the previous snapshot when storage quota is exceeded", async () => {
  const { commitSave } = await import("../src/save-state.js");
  const library = createSaveLibrary();
  assert.equal(saveState(library, 7, 1, new Uint8Array([1, 2, 3])).ok, true);
  let writes = 0;
  const result = commitSave(library, 7, 1, new Uint8Array([4, 5]), {
    setItem() {
      writes += 1;
      throw quotaError();
    },
    getItem() {
      return null;
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "Could not store that save because storage is full.");
  assert.equal(writes, 1);
  assert.deepEqual([...loadState(library, 7, 1).bytes], [1, 2, 3]);
});

test("a quota failure on the first save leaves the slot empty", async () => {
  const { commitSave } = await import("../src/save-state.js");
  const library = createSaveLibrary();
  const result = commitSave(library, 2, 3, new Uint8Array([1]), {
    setItem() {
      throw quotaError();
    },
    getItem() {
      return null;
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "Could not store that save because storage is full.");
  const loaded = loadState(library, 2, 3);
  assert.equal(loaded.ok, false);
  assert.equal(loaded.error, "No save in that slot.");
  assert.equal("bytes" in loaded, false);
});

test("commitSave does not replace a snapshot when storage is unavailable", async () => {
  const { commitSave } = await import("../src/save-state.js");
  const library = createSaveLibrary();
  saveState(library, 7, 1, new Uint8Array([1, 2, 3]));
  const missing = commitSave(library, 7, 1, new Uint8Array([9]), null);
  assert.equal(missing.ok, false);
  assert.equal(missing.error, "Could not store that save because storage is unavailable.");
  assert.deepEqual([...loadState(library, 7, 1).bytes], [1, 2, 3]);

  const denied = commitSave(library, 7, 1, new Uint8Array([9]), {
    setItem() {
      const error = new Error("denied");
      error.name = "SecurityError";
      throw error;
    },
    getItem() {
      return null;
    },
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.error, "Could not store that save because storage is unavailable.");
  assert.deepEqual([...loadState(library, 7, 1).bytes], [1, 2, 3]);
});

test("commitSave rejects a truncated stored snapshot and keeps the previous save", async () => {
  const { commitSave } = await import("../src/save-state.js");
  const library = createSaveLibrary();
  saveState(library, 4, 2, new Uint8Array([8, 8]));
  const map = new Map();
  const result = commitSave(library, 4, 2, new Uint8Array([1, 2, 3, 4]), {
    setItem(key, value) {
      map.set(key, String(value).slice(0, -1));
    },
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    removeItem(key) {
      map.delete(key);
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "Save state did not roundtrip.");
  assert.deepEqual([...loadState(library, 4, 2).bytes], [8, 8]);
  assert.equal(map.size, 0);
});

test("a quota failure puts the previous stored save back", async () => {
  const { commitSave } = await import("../src/save-state.js");
  const library = createSaveLibrary();
  const prior = new Uint8Array([1, 2, 3]);
  assert.equal(saveState(library, 7, 1, prior).ok, true);
  const key = saveRecordKey(7, 1);
  const encoded = encodeSaveBytes(prior);
  const map = new Map([[key, encoded]]);
  const removed = [];
  const result = commitSave(library, 7, 1, new Uint8Array([4, 5, 6, 7]), {
    setItem(storageKey, value) {
      if (value !== encoded) {
        map.delete(storageKey);
        throw quotaError();
      }
      map.set(storageKey, value);
    },
    getItem(storageKey) {
      return map.has(storageKey) ? map.get(storageKey) : null;
    },
    removeItem(storageKey) {
      removed.push(storageKey);
      map.delete(storageKey);
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "Could not store that save because storage is full.");
  assert.deepEqual([...loadState(library, 7, 1).bytes], [1, 2, 3]);
  assert.deepEqual(removed, []);
  assert.deepEqual([...(decodeSaveBytes(map.get(key)) || [])], [1, 2, 3]);
});

test("a truncated write puts the previous stored save back", async () => {
  const { commitSave } = await import("../src/save-state.js");
  const library = createSaveLibrary();
  const prior = new Uint8Array([8, 8]);
  assert.equal(saveState(library, 4, 2, prior).ok, true);
  const key = saveRecordKey(4, 2);
  const encoded = encodeSaveBytes(prior);
  const map = new Map([[key, encoded]]);
  let writes = 0;
  const result = commitSave(library, 4, 2, new Uint8Array([1, 2, 3, 4]), {
    setItem(storageKey, value) {
      writes += 1;
      map.set(storageKey, writes === 1 ? String(value).slice(0, -1) : String(value));
    },
    getItem(storageKey) {
      return map.has(storageKey) ? map.get(storageKey) : null;
    },
    removeItem(storageKey) {
      map.delete(storageKey);
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "Save state did not roundtrip.");
  assert.equal(writes, 2);
  assert.deepEqual([...loadState(library, 4, 2).bytes], [8, 8]);
  assert.deepEqual([...(decodeSaveBytes(map.get(key)) || [])], [8, 8]);
});

test("commitSave does not store an empty snapshot", async () => {
  const { commitSave } = await import("../src/save-state.js");
  const library = createSaveLibrary();
  saveState(library, 1, 1, new Uint8Array([1, 2]));
  let writes = 0;
  const result = commitSave(library, 1, 1, new Uint8Array(), {
    setItem() {
      writes += 1;
    },
    getItem() {
      return null;
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "Cannot save that state.");
  assert.equal(writes, 0);
  assert.deepEqual([...loadState(library, 1, 1).bytes], [1, 2]);
});
