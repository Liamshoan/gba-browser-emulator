// Browser storage used by save roundtrips.
// localStorage is injected so tests can fail a write on purpose.

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

export function writeStorageFailure(error) {
  return isQuota(error)
    ? "Could not store that save because storage is full."
    : "Could not store that save because storage is unavailable.";
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
