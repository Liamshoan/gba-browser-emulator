import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeSaveBytes,
  encodeSaveBytes,
  saveRecordKey,
} from "../src/browser-storage.js";
import { commitSave, createSaveLibrary, loadState } from "../src/save-state.js";

function quotaError(shape = "name") {
  const error = new Error("quota");
  if (shape === "name") error.name = "QuotaExceededError";
  if (shape === "firefox") error.name = "NS_ERROR_DOM_QUOTA_REACHED";
  if (shape === "code") error.code = 22;
  return error;
}

function memoryStorage(map = new Map()) {
  return {
    map,
    setItem(key, value) {
      map.set(key, String(value));
    },
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    removeItem(key) {
      map.delete(key);
    },
  };
}

function storedBytes(storage, gameId, slot) {
  return decodeSaveBytes(storage.getItem(saveRecordKey(gameId, slot)));
}

test("a load during a save sees the snapshot already committed", () => {
  const library = createSaveLibrary();
  const storage = memoryStorage();
  assert.equal(commitSave(library, 7, 1, new Uint8Array([1, 2, 3]), storage).ok, true);

  let seen = null;
  const next = new Uint8Array([4, 5]);
  const saved = commitSave(library, 7, 1, next, {
    setItem(key, value) {
      seen = loadState(library, 7, 1);
      storage.setItem(key, value);
    },
    getItem(key) {
      return storage.getItem(key);
    },
    removeItem(key) {
      storage.removeItem(key);
    },
  });

  assert.equal(saved.ok, true);
  assert.equal(seen.ok, true);
  assert.deepEqual([...seen.bytes], [1, 2, 3]);
  seen.bytes[0] = 0;
  assert.deepEqual([...loadState(library, 7, 1).bytes], [4, 5]);
  assert.deepEqual([...storedBytes(storage, 7, 1)], [4, 5]);
});

test("a re-entered save of the same slot does not replace the in-flight save", () => {
  const library = createSaveLibrary();
  const storage = memoryStorage();
  assert.equal(commitSave(library, 7, 1, new Uint8Array([1, 2, 3]), storage).ok, true);

  let calls = 0;
  let inner = null;
  const saved = commitSave(library, 7, 1, new Uint8Array([4, 5]), {
    setItem(key, value) {
      calls += 1;
      if (calls === 1) {
        inner = commitSave(library, 7, 1, new Uint8Array([6]), storage);
      }
      storage.setItem(key, value);
    },
    getItem(key) {
      return storage.getItem(key);
    },
    removeItem(key) {
      storage.removeItem(key);
    },
  });

  assert.equal(calls, 1);
  assert.equal(inner.ok, false);
  assert.equal(inner.error, "Save already in progress.");
  assert.equal("bytes" in inner, false);
  assert.equal(saved.ok, true);
  assert.equal(saved.replaced, true);
  assert.deepEqual([...saved.bytes], [4, 5]);
  assert.deepEqual([...loadState(library, 7, 1).bytes], [4, 5]);
  assert.deepEqual([...storedBytes(storage, 7, 1)], [4, 5]);
});

test("a quota failure does not discard a different slot saved during the write", () => {
  const library = createSaveLibrary();
  const storage = memoryStorage();
  assert.equal(commitSave(library, 7, 1, new Uint8Array([1, 2, 3]), storage).ok, true);
  assert.equal(commitSave(library, 7, 2, new Uint8Array([2]), storage).ok, true);
  const slot1Record = storage.getItem(saveRecordKey(7, 1));

  let inner = null;
  let during = null;
  const saved = commitSave(library, 7, 1, new Uint8Array([9, 9]), {
    setItem(key, value) {
      if (key === saveRecordKey(7, 1)) {
        during = loadState(library, 7, 1);
        inner = commitSave(library, 7, 2, new Uint8Array([8, 8]), storage);
        throw quotaError();
      }
      storage.setItem(key, value);
    },
    getItem(key) {
      return storage.getItem(key);
    },
    removeItem(key) {
      storage.removeItem(key);
    },
  });

  assert.equal(inner.ok, true);
  assert.deepEqual([...during.bytes], [1, 2, 3]);
  assert.equal(saved.ok, false);
  assert.equal(saved.error, "Could not store that save because storage is full.");
  assert.deepEqual([...loadState(library, 7, 1).bytes], [1, 2, 3]);
  assert.equal(storage.getItem(saveRecordKey(7, 1)), slot1Record);
  assert.deepEqual([...loadState(library, 7, 2).bytes], [8, 8]);
  assert.deepEqual([...storedBytes(storage, 7, 2)], [8, 8]);
});

test("a quota failure leaves the previously stored snapshot in place", () => {
  const library = createSaveLibrary();
  const storage = memoryStorage();
  const previous = new Uint8Array([1, 2, 3]);
  assert.equal(commitSave(library, 4, 2, previous, storage).ok, true);
  const record = storage.getItem(saveRecordKey(4, 2));
  let writes = 0;
  let removals = 0;

  const saved = commitSave(library, 4, 2, new Uint8Array([4, 5, 6, 7]), {
    setItem() {
      writes += 1;
      throw quotaError();
    },
    getItem(key) {
      return storage.getItem(key);
    },
    removeItem(key) {
      removals += 1;
      storage.removeItem(key);
    },
  });

  assert.equal(saved.ok, false);
  assert.equal(saved.error, "Could not store that save because storage is full.");
  assert.equal(writes, 1);
  assert.equal(removals, 0);
  assert.deepEqual([...loadState(library, 4, 2).bytes], [1, 2, 3]);
  assert.equal(storage.getItem(saveRecordKey(4, 2)), record);
  assert.deepEqual([...storedBytes(storage, 4, 2)], [1, 2, 3]);
});

test("a quota failure after a partial write puts the previous snapshot back", () => {
  const library = createSaveLibrary();
  const storage = memoryStorage();
  const previous = new Uint8Array([0, 255, 1]);
  assert.equal(commitSave(library, 3, 1, previous, storage).ok, true);
  const record = storage.getItem(saveRecordKey(3, 1));

  const saved = commitSave(library, 3, 1, new Uint8Array([2, 3, 4, 5]), {
    setItem(key, value) {
      if (value !== record) {
        storage.setItem(key, value);
        throw quotaError();
      }
      storage.setItem(key, value);
    },
    getItem(key) {
      return storage.getItem(key);
    },
    removeItem(key) {
      storage.removeItem(key);
    },
  });

  assert.equal(saved.ok, false);
  assert.equal(saved.error, "Could not store that save because storage is full.");
  assert.deepEqual([...loadState(library, 3, 1).bytes], [0, 255, 1]);
  assert.equal(storage.getItem(saveRecordKey(3, 1)), record);
  assert.deepEqual([...storedBytes(storage, 3, 1)], [0, 255, 1]);
});

test("a truncated overwrite restores the previous stored snapshot", () => {
  const library = createSaveLibrary();
  const storage = memoryStorage();
  assert.equal(commitSave(library, 4, 2, new Uint8Array([8, 8]), storage).ok, true);
  const record = storage.getItem(saveRecordKey(4, 2));

  const saved = commitSave(library, 4, 2, new Uint8Array([1, 2, 3, 4]), {
    setItem(key, value) {
      const text = String(value);
      storage.setItem(key, text === record ? text : text.slice(0, -1));
    },
    getItem(key) {
      return storage.getItem(key);
    },
    removeItem(key) {
      storage.removeItem(key);
    },
  });

  assert.equal(saved.ok, false);
  assert.equal(saved.error, "Save state did not roundtrip.");
  assert.deepEqual([...loadState(library, 4, 2).bytes], [8, 8]);
  assert.equal(storage.getItem(saveRecordKey(4, 2)), record);
});

test("a quota failure while reading the stored save puts the previous snapshot back", () => {
  const library = createSaveLibrary();
  const storage = memoryStorage();
  const previous = new Uint8Array([8, 7, 6]);
  assert.equal(commitSave(library, 5, 4, previous, storage).ok, true);
  const record = storage.getItem(saveRecordKey(5, 4));
  let reads = 0;

  const saved = commitSave(library, 5, 4, new Uint8Array([1, 1]), {
    setItem(key, value) {
      storage.setItem(key, value);
    },
    getItem(key) {
      reads += 1;
      if (reads === 2) throw quotaError();
      return storage.getItem(key);
    },
    removeItem(key) {
      storage.removeItem(key);
    },
  });

  assert.equal(saved.ok, false);
  assert.equal(saved.error, "Could not store that save because storage is full.");
  assert.deepEqual([...loadState(library, 5, 4).bytes], [8, 7, 6]);
  assert.equal(storage.getItem(saveRecordKey(5, 4)), record);
});

test("a save that does not fit leaves other slots and the previous snapshot stored", () => {
  const library = createSaveLibrary();
  const small = new Uint8Array([1]);
  const smallRecord = encodeSaveBytes(small);
  const map = new Map();
  const storage = {
    setItem(key, value) {
      const text = String(value);
      const next = new Map(map);
      next.set(key, text);
      let used = 0;
      for (const item of next.values()) used += item.length;
      if (used > smallRecord.length) throw quotaError();
      map.set(key, text);
    },
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    removeItem(key) {
      map.delete(key);
    },
  };

  const first = commitSave(library, 1, 1, small, storage);
  assert.equal(first.ok, true);
  assert.equal(map.get(saveRecordKey(1, 1)), smallRecord);

  const other = commitSave(library, 2, 1, new Uint8Array(32), storage);
  assert.equal(other.ok, false);
  assert.equal(other.error, "Could not store that save because storage is full.");
  assert.equal(loadState(library, 2, 1).ok, false);
  assert.equal(map.has(saveRecordKey(2, 1)), false);
  assert.deepEqual([...loadState(library, 1, 1).bytes], [1]);
  assert.equal(map.get(saveRecordKey(1, 1)), smallRecord);

  const replacement = commitSave(library, 1, 1, new Uint8Array([2]), storage);
  assert.equal(replacement.ok, true);
  assert.equal(replacement.replaced, true);
  assert.deepEqual([...loadState(library, 1, 1).bytes], [2]);
  assert.deepEqual([...storedBytes(storage, 1, 1)], [2]);

  const kept = map.get(saveRecordKey(1, 1));
  const tooBig = commitSave(library, 1, 1, new Uint8Array([3, 4, 5, 6]), storage);
  assert.equal(tooBig.ok, false);
  assert.equal(tooBig.error, "Could not store that save because storage is full.");
  assert.deepEqual([...loadState(library, 1, 1).bytes], [2]);
  assert.equal(map.get(saveRecordKey(1, 1)), kept);
  assert.equal(map.size, 1);
});

test("legacy quota errors leave the stored snapshot in place", () => {
  for (const shape of ["firefox", "code"]) {
    const library = createSaveLibrary();
    const storage = memoryStorage();
    assert.equal(commitSave(library, 8, 1, new Uint8Array([1, 2]), storage).ok, true);
    const record = storage.getItem(saveRecordKey(8, 1));
    const saved = commitSave(library, 8, 1, new Uint8Array([3, 4, 5]), {
      setItem() {
        throw quotaError(shape);
      },
      getItem(key) {
        return storage.getItem(key);
      },
      removeItem(key) {
        storage.removeItem(key);
      },
    });
    assert.equal(saved.ok, false, shape);
    assert.equal(saved.error, "Could not store that save because storage is full.", shape);
    assert.deepEqual([...loadState(library, 8, 1).bytes], [1, 2]);
    assert.equal(storage.getItem(saveRecordKey(8, 1)), record, shape);
  }
});

test("mutating the source buffer during the write does not change the saved bytes", () => {
  const library = createSaveLibrary();
  const raw = new Uint8Array([0, 4, 5, 6, 0]);
  const view = raw.subarray(1, 4);
  const map = new Map();
  const saved = commitSave(library, 3, 9, view, {
    setItem(key, value) {
      raw[1] = 9;
      view[2] = 8;
      map.set(key, String(value));
    },
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    removeItem(key) {
      map.delete(key);
    },
  });

  assert.equal(saved.ok, true);
  assert.equal(saved.replaced, false);
  assert.deepEqual([...saved.bytes], [4, 5, 6]);
  saved.bytes[0] = 0;
  assert.deepEqual([...loadState(library, 3, 9).bytes], [4, 5, 6]);
  assert.deepEqual([...storedBytes({ getItem: (key) => map.get(key) ?? null }, 3, 9)], [4, 5, 6]);
});

test("a storage read failure before the write does not remove the slot", () => {
  const library = createSaveLibrary();
  const storage = memoryStorage();
  assert.equal(commitSave(library, 6, 1, new Uint8Array([1, 2, 3]), storage).ok, true);
  const record = storage.getItem(saveRecordKey(6, 1));
  let writes = 0;
  let removals = 0;

  const saved = commitSave(library, 6, 1, new Uint8Array([4]), {
    setItem() {
      writes += 1;
    },
    getItem() {
      const error = new Error("denied");
      error.name = "SecurityError";
      throw error;
    },
    removeItem() {
      removals += 1;
    },
  });

  assert.equal(saved.ok, false);
  assert.equal(saved.error, "Could not store that save because storage is unavailable.");
  assert.equal(writes, 0);
  assert.equal(removals, 0);
  assert.deepEqual([...loadState(library, 6, 1).bytes], [1, 2, 3]);
  assert.equal(storage.getItem(saveRecordKey(6, 1)), record);
});
