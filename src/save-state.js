// In-memory save slots. EmulatorJS keeps the real snapshots in the player
// frame; this library is the deterministic policy for slot load and for a
// second save to a slot that already has a snapshot.

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
  if (!(bytes instanceof Uint8Array)) {
    return { ok: false, error: "Cannot save that state." };
  }

  let slots = library.games.get(id);
  if (!slots) {
    slots = new Map();
    library.games.set(id, slots);
  }
  const replaced = slots.has(slotId);
  slots.set(slotId, new Uint8Array(bytes));
  return { ok: true, gameId: id, slot: slotId, replaced };
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
