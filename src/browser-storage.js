// Browser storage used by save roundtrips and session teardown.
// localStorage and IndexedDB are injected so tests can fail them on purpose.

const STORE_NAME = "gba-rom-session";

export function saveRecordKey(gameId, slot) {
  return `${STORE_NAME}:${gameId}:${slot}`;
}

function isQuota(error) {
  const name = error && error.name;
  return (
    name === "QuotaExceededError" ||
    name === "NS_ERROR_DOM_QUOTA_REACHED" ||
    (error && error.code === 22)
  );
}

export function clearStorageFailure(error) {
  return isQuota(error)
    ? "Could not clear saved data because storage is full."
    : "Could not clear saved data because storage is unavailable.";
}

export function writeStorageFailure(error) {
  return isQuota(error)
    ? "Could not store that save because storage is full."
    : "Could not store that save because storage is unavailable.";
}

function unavailable() {
  const error = new Error("storage is unavailable");
  error.name = "SecurityError";
  throw error;
}

function listKeys(localStorage) {
  if (typeof localStorage.key !== "function") return [];
  const length = Number(localStorage.length) || 0;
  const keys = [];
  for (let i = 0; i < length; i++) keys.push(localStorage.key(i));
  return keys;
}

function clearLocal(localStorage) {
  if (localStorage == null || typeof localStorage.removeItem !== "function") unavailable();
  const doomed = [];
  const seen = new Set();
  const push = (key) => {
    if (typeof key !== "string" || seen.has(key)) return;
    if (key === STORE_NAME || key.startsWith(`${STORE_NAME}:`)) {
      seen.add(key);
      doomed.push(key);
    }
  };
  push(STORE_NAME);
  for (const key of listKeys(localStorage)) push(key);
  for (const key of doomed) localStorage.removeItem(key);
}

function clearIndexedDb(indexedDB) {
  if (indexedDB == null || typeof indexedDB.deleteDatabase !== "function") unavailable();
  const request = indexedDB.deleteDatabase(STORE_NAME);
  if (request && request.error) throw request.error;
}

export function clearSessionStores(deps = {}) {
  const errors = [];
  if ("localStorage" in deps) {
    try {
      clearLocal(deps.localStorage);
    } catch (error) {
      errors.push(error);
    }
  }
  if ("indexedDB" in deps) {
    try {
      clearIndexedDb(deps.indexedDB);
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

export function encodeSaveBytes(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return `${bytes.length}:${btoa(binary)}`;
}

export function decodeSaveBytes(text) {
  if (typeof text !== "string") return null;
  const splitAt = text.indexOf(":");
  if (splitAt <= 0) return null;
  const length = Number(text.slice(0, splitAt));
  if (!Number.isInteger(length) || length <= 0) return null;
  let binary;
  try {
    binary = atob(text.slice(splitAt + 1));
  } catch {
    return null;
  }
  if (binary.length !== length) return null;
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = binary.charCodeAt(i) & 0xff;
  return out;
}
