// In-memory save slots. EmulatorJS keeps the real snapshots in the player
// frame; this library is the deterministic policy for slot load and for a
// second save to a slot that already has a snapshot. commitSave also writes
// one record through an injected storage object. A truncated, full, or
// unavailable write rolls the slot back and puts the previous stored
// record back. Deleting that record would leave the slot empty.

import {
  decodeSaveBytes,
  encodeSaveBytes,
  saveRecordKey,
  writeStorageFailure,
} from "./browser-storage.js";

const MIN_SLOT = 1;
const MAX_SLOT = 9;

export function createSaveLibrary() {
  return { games: new Map() };
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

function dropSlot(library, gameId, slot) {
  const slots = library.games.get(gameId);
  if (!slots) return;
  slots.delete(slot);
  if (slots.size === 0) library.games.delete(gameId);
}

function rollback(library, gameId, slot, previous) {
  if (previous.ok) {
    saveState(library, gameId, slot, previous.bytes);
    return;
  }
  dropSlot(library, gameId, slot);
}

function bestEffortRemove(storage, key) {
  if (!storage || typeof storage.removeItem !== "function") return;
  try {
    storage.removeItem(key);
  } catch {
    // The caller already has a storage error to report.
  }
}

// Put the record that was stored before this attempt back. Removing the key
// instead drops that save when the new write was rejected or truncated.
// A missing prior record is the one case where the failed write should go.
function restorePriorSave(storage, key, priorRecord) {
  if (typeof priorRecord === "string") {
    try {
      storage.setItem(key, priorRecord);
    } catch {
      // The prior record could not be written back. Deleting the key would
      // leave nothing, so keep whatever the failed write still holds.
    }
    return;
  }
  if (priorRecord === null) bestEffortRemove(storage, key);
}

export function commitSave(library, gameId, slot, bytes, storage) {
  if (
    storage == null ||
    typeof storage.setItem !== "function" ||
    typeof storage.getItem !== "function"
  ) {
    return { ok: false, error: "Could not store that save because storage is unavailable." };
  }

  const previous = loadState(library, gameId, slot);
  const saved = saveState(library, gameId, slot, bytes);
  if (!saved.ok) return saved;

  const key = saveRecordKey(saved.gameId, saved.slot);
  const snapshot = loadState(library, saved.gameId, saved.slot).bytes;
  let priorRecord;
  try {
    priorRecord = storage.getItem(key);
  } catch (error) {
    rollback(library, saved.gameId, saved.slot, previous);
    return { ok: false, error: writeStorageFailure(error) };
  }
  if (priorRecord != null && typeof priorRecord !== "string") priorRecord = undefined;

  try {
    storage.setItem(key, encodeSaveBytes(snapshot));
    const decoded = decodeSaveBytes(storage.getItem(key));
    if (!decoded || !equalBytes(decoded, snapshot)) {
      restorePriorSave(storage, key, priorRecord);
      rollback(library, saved.gameId, saved.slot, previous);
      return { ok: false, error: "Save state did not roundtrip." };
    }
  } catch (error) {
    restorePriorSave(storage, key, priorRecord);
    rollback(library, saved.gameId, saved.slot, previous);
    return { ok: false, error: writeStorageFailure(error) };
  }

  return {
    ok: true,
    gameId: saved.gameId,
    slot: saved.slot,
    replaced: saved.replaced,
    bytes: loadState(library, saved.gameId, saved.slot).bytes,
  };
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
