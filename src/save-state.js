// In-memory save slots plus one stored record per slot.
// commitSave publishes a snapshot only after storage accepts it. A load
// during that write still sees the previous snapshot. A re-entered save of
// the same slot fails without replacing it. A failed write puts the previous
// stored record back when the attempt changed it.

import {
  decodeSaveBytes,
  encodeSaveBytes,
  saveRecordKey,
  writeStorageFailure,
} from "./browser-storage.js";

const MIN_SLOT = 1;
const MAX_SLOT = 9;

export function createSaveLibrary() {
  return { games: new Map(), pending: new Set() };
}

function gameNumber(gameId) {
  const id = Number(gameId);
  if (!Number.isInteger(id) || id <= 0) return null;
  return id;
}

function slotNumber(slot) {
  if (!Number.isInteger(slot) || slot < MIN_SLOT || slot > MAX_SLOT) return null;
  return slot;
}

export function saveState(library, gameId, slot, bytes) {
  const id = gameNumber(gameId);
  if (id === null) return { ok: false, error: "Cannot save without a game id." };
  const slotId = slotNumber(slot);
  if (slotId === null) return { ok: false, error: "That save slot does not exist." };
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    return { ok: false, error: "Cannot save that state." };
  }
  let copy;
  try {
    copy = new Uint8Array(bytes);
  } catch {
    return { ok: false, error: "Cannot save that state." };
  }

  let slots = library.games.get(id);
  if (!slots) {
    slots = new Map();
    library.games.set(id, slots);
  }
  const replaced = slots.has(slotId);
  slots.set(slotId, copy);
  return { ok: true, gameId: id, slot: slotId, replaced };
}

function equalBytes(left, right) {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function bestEffortRemove(storage, key) {
  if (!storage || typeof storage.removeItem !== "function") return;
  try {
    storage.removeItem(key);
  } catch {
    // The caller already has a storage error to report.
  }
}

function restoreStorage(storage, key, previousRecord) {
  let current;
  try {
    current = storage.getItem(key);
  } catch {
    current = undefined;
  }
  if (current === previousRecord) return;
  if (previousRecord == null) {
    bestEffortRemove(storage, key);
    return;
  }
  try {
    storage.setItem(key, previousRecord);
    let after;
    try {
      after = storage.getItem(key);
    } catch {
      after = undefined;
    }
    if (after !== previousRecord) bestEffortRemove(storage, key);
  } catch {
    bestEffortRemove(storage, key);
  }
}

export function commitSave(library, gameId, slot, bytes, storage) {
  if (
    storage == null ||
    typeof storage.setItem !== "function" ||
    typeof storage.getItem !== "function"
  ) {
    return { ok: false, error: "Could not store that save because storage is unavailable." };
  }

  const id = gameNumber(gameId);
  if (id === null) return { ok: false, error: "Cannot save without a game id." };
  const slotId = slotNumber(slot);
  if (slotId === null) return { ok: false, error: "That save slot does not exist." };
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    return { ok: false, error: "Cannot save that state." };
  }
  let copy;
  try {
    copy = new Uint8Array(bytes);
  } catch {
    return { ok: false, error: "Cannot save that state." };
  }

  if (!library.pending) library.pending = new Set();
  const lock = `${id}:${slotId}`;
  if (library.pending.has(lock)) {
    return { ok: false, error: "Save already in progress." };
  }

  library.pending.add(lock);
  try {
    const key = saveRecordKey(id, slotId);
    let previousRecord;
    try {
      previousRecord = storage.getItem(key);
    } catch (error) {
      return { ok: false, error: writeStorageFailure(error) };
    }

    try {
      storage.setItem(key, encodeSaveBytes(copy));
      const decoded = decodeSaveBytes(storage.getItem(key));
      if (!decoded || !equalBytes(decoded, copy)) {
        restoreStorage(storage, key, previousRecord);
        return { ok: false, error: "Save state did not roundtrip." };
      }
    } catch (error) {
      restoreStorage(storage, key, previousRecord);
      return { ok: false, error: writeStorageFailure(error) };
    }

    const saved = saveState(library, id, slotId, copy);
    if (!saved.ok) {
      restoreStorage(storage, key, previousRecord);
      return saved;
    }
    return {
      ok: true,
      gameId: saved.gameId,
      slot: saved.slot,
      replaced: saved.replaced,
      bytes: loadState(library, id, slotId).bytes,
    };
  } finally {
    library.pending.delete(lock);
  }
}

export function loadState(library, gameId, slot) {
  const id = gameNumber(gameId);
  if (id === null) return { ok: false, error: "Cannot load without a game id." };
  const slotId = slotNumber(slot);
  if (slotId === null) return { ok: false, error: "That save slot does not exist." };

  const slots = library.games.get(id);
  const saved = slots && slots.get(slotId);
  if (!saved) return { ok: false, error: "No save in that slot." };
  return { ok: true, gameId: id, slot: slotId, bytes: new Uint8Array(saved) };
}
