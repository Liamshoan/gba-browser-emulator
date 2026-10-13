// Pure ROM-session helpers for the browser page.
//
// EmulatorJS reads EJS_gameUrl once, when loader.js runs. EJS_ready is a
// callback the emulator invokes; calling it does not load another ROM.
// Blob URLs also skip in-browser saves unless EJS_gameName is a string, and
// a missing EJS_gameID stores every game under id 1 (0 is treated as unset).

export const EMULATOR_DATA_PATH = "https://cdn.emulatorjs.org/stable/data/";

const HEADER_LENGTH = 0xc0;
// Retail carts and the Game Pak ROM window both stop at 32 MiB.
export const MAX_GBA_ROM_BYTES = 32 * 1024 * 1024;
const TITLE_OFFSET = 0xa0;
const TITLE_LENGTH = 12;
const CODE_OFFSET = 0xac;
const FIXED_OFFSET = 0xb2;
const FIXED_BYTE = 0x96;
const CHECKSUM_OFFSET = 0xbd;
const CHECKSUM_ADJUST = 0x19;

const UNSAFE_NAME = /[#<$+%>!`&*'|{}/\\?"=@:^\r\n]/g;

export function createRomSession() {
  return {
    generation: 0,
    pendingName: null,
    fileName: null,
    bytes: null,
    activeUrl: null,
    readError: null,
  };
}

// Drop any ROM already buffered so Play cannot start the previous file
// while a newer selection is still reading.
export function beginFileRead(session, fileName) {
  session.generation += 1;
  session.pendingName = fileName;
  session.fileName = null;
  session.bytes = null;
  session.readError = null;
  return session.generation;
}

export function finishFileRead(session, generation, bytes, error) {
  if (generation !== session.generation) return { applied: false };
  const fileName = session.pendingName;
  session.pendingName = null;
  if (error || !(bytes instanceof Uint8Array)) {
    session.bytes = null;
    session.fileName = null;
    session.readError = "Could not read that file.";
    return { applied: true, ready: false, fileName };
  }
  session.bytes = bytes;
  session.fileName = fileName;
  session.readError = null;
  return { applied: true, ready: true, fileName };
}

export function gbaHeaderChecksum(bytes) {
  let sum = 0;
  for (let i = TITLE_OFFSET; i < CHECKSUM_OFFSET; i++) {
    sum = (sum - bytes[i]) & 0xff;
  }
  return (sum - CHECKSUM_ADJUST) & 0xff;
}

export function asGameId(n) {
  const id = Number(n) >>> 0;
  return id === 0 ? 1 : id;
}

function fnv1a32(bytes) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function readAscii(bytes, offset, length) {
  let out = "";
  for (let i = 0; i < length; i++) {
    const code = bytes[offset + i];
    if (code === 0) break;
    out += String.fromCharCode(code);
  }
  return out.trim();
}

function readGameCode(bytes) {
  const code = readAscii(bytes, CODE_OFFSET, 4);
  return /^[A-Za-z0-9]{4}$/.test(code) ? code.toUpperCase() : "";
}

function saveGameName(fileName, gameCode) {
  const base = String(fileName).split(/[/\\]/).pop() || "";
  const cleaned = base.replace(UNSAFE_NAME, "").trim();
  if (cleaned && gameCode) return `${cleaned} [${gameCode}]`;
  return cleaned || gameCode || "game.gba";
}

export function inspectGbaRom(bytes, fileName) {
  const name = typeof fileName === "string" ? fileName.trim() : "";
  if (!name.toLowerCase().endsWith(".gba")) {
    return { ok: false, error: "Select a file that ends in .gba." };
  }
  if (!(bytes instanceof Uint8Array) || bytes.length < HEADER_LENGTH) {
    return { ok: false, error: "This file is too small to be a GBA ROM." };
  }
  if (bytes.length > MAX_GBA_ROM_BYTES) {
    return { ok: false, error: "This GBA ROM is larger than 32 MiB." };
  }
  if (bytes[FIXED_OFFSET] !== FIXED_BYTE) {
    return {
      ok: false,
      error: "This file is not a GBA ROM (missing required header byte).",
    };
  }
  const expected = gbaHeaderChecksum(bytes);
  if (bytes[CHECKSUM_OFFSET] !== expected) {
    return { ok: false, error: "This GBA ROM has an invalid header checksum." };
  }
  const gameCode = readGameCode(bytes);
  return {
    ok: true,
    title: readAscii(bytes, TITLE_OFFSET, TITLE_LENGTH),
    gameCode,
    gameName: saveGameName(name, gameCode),
    gameId: asGameId(fnv1a32(bytes)),
  };
}

export function buildPlayerDocument({ gameUrl, gameName, gameId }) {
  const payload = JSON.stringify({
    player: "#game",
    core: "gba",
    gameUrl,
    gameName,
    gameId,
    dataPath: EMULATOR_DATA_PATH,
  })
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <style>
    html, body, #game { margin: 0; width: 100%; height: 100%; background: #000; }
  </style>
</head>
<body>
  <div id="game"></div>
  <script>
    const cfg = ${payload};
    window.EJS_player = cfg.player;
    window.EJS_core = cfg.core;
    window.EJS_gameUrl = cfg.gameUrl;
    window.EJS_gameName = cfg.gameName;
    window.EJS_gameID = cfg.gameId;
    window.EJS_pathtodata = cfg.dataPath;
  </script>
  <script src="${EMULATOR_DATA_PATH}loader.js"></script>
</body>
</html>`;
}

export function planLaunch(session, deps) {
  if (session.pendingName) {
    return {
      ok: false,
      error: "Still reading the ROM. Wait a moment, then press Play.",
    };
  }
  if (session.readError) return { ok: false, error: session.readError };
  if (!session.bytes || !session.fileName) {
    return { ok: false, error: "Please select a .gba file first" };
  }
  const inspection = inspectGbaRom(session.bytes, session.fileName);
  if (!inspection.ok) return { ok: false, error: inspection.error };

  const gameUrl = deps.createObjectUrl(session.bytes);
  const revokeUrl = session.activeUrl;
  session.activeUrl = gameUrl;
  return {
    ok: true,
    revokeUrl,
    gameUrl,
    gameName: inspection.gameName,
    gameId: inspection.gameId,
    playerDocument: buildPlayerDocument({
      gameUrl,
      gameName: inspection.gameName,
      gameId: inspection.gameId,
    }),
  };
}
