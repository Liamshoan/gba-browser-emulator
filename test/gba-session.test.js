import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  asGameId,
  beginFileRead,
  buildPlayerDocument,
  createRomSession,
  EMULATOR_DATA_PATH,
  finishFileRead,
  gbaHeaderChecksum,
  inspectGbaRom,
  planLaunch,
} from "../src/gba-session.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function writeAscii(bytes, offset, text) {
  for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i);
}

// GBATEK header checksum, written out here so it is not the implementation.
function specChecksum(bytes) {
  let chk = 0;
  for (let i = 0xa0; i <= 0xbc; i++) chk = (chk - bytes[i]) & 0xff;
  return (chk - 0x19) & 0xff;
}

function makeRom({ title = "TEST", code = "T001", extra = [], checksum } = {}) {
  const bytes = new Uint8Array(0xc0 + extra.length);
  writeAscii(bytes, 0xa0, title);
  writeAscii(bytes, 0xac, code);
  bytes[0xb2] = 0x96;
  for (let i = 0; i < extra.length; i++) bytes[0xc0 + i] = extra[i];
  bytes[0xbd] = checksum === undefined ? specChecksum(bytes) : checksum;
  return bytes;
}

function launch(session, url) {
  return planLaunch(session, {
    createObjectUrl() {
      return url;
    },
  });
}

function launchRefused(bytes, fileName) {
  const session = createRomSession();
  const generation = beginFileRead(session, fileName);
  const ready = finishFileRead(session, generation, bytes);
  const plan = planLaunch(session, {
    createObjectUrl() {
      throw new Error("should not create a URL");
    },
  });
  return { ready, plan };
}

function romOfSize(size) {
  const bytes = new Uint8Array(size);
  writeAscii(bytes, 0xa0, "HUGE");
  writeAscii(bytes, 0xac, "HUGE");
  bytes[0xb2] = 0x96;
  bytes[0xbd] = specChecksum(bytes);
  return bytes;
}

test("header checksum matches the known TEST cartridge vector", () => {
  const bytes = new Uint8Array(0xc0);
  writeAscii(bytes, 0xa0, "TEST");
  bytes[0xb2] = 0x96;
  assert.equal(gbaHeaderChecksum(bytes), 0x11);
  assert.equal(gbaHeaderChecksum(bytes), specChecksum(bytes));
});

test("a zero game id is rewritten because EmulatorJS treats 0 as unset", () => {
  assert.equal(asGameId(0), 1);
  assert.equal(asGameId(0x100000000), 1);
  assert.equal(asGameId(42), 42);
});

test("overlapping reads keep the newest file and will not play the stale one", () => {
  const session = createRomSession();
  const first = beginFileRead(session, "slow.gba");
  const ready = finishFileRead(session, first, makeRom({ title: "SLOW", code: "SLOW" }));
  assert.equal(ready.applied, true);

  const stale = beginFileRead(session, "slow.gba");
  const latest = beginFileRead(session, "fast.gba");
  assert.equal(session.bytes, null);

  const whileReading = planLaunch(session, {
    createObjectUrl() {
      throw new Error("should not create a URL while a read is in flight");
    },
  });
  assert.equal(whileReading.ok, false);
  assert.match(whileReading.error, /Still reading/);

  const late = finishFileRead(session, stale, makeRom({ title: "SLOW", code: "SLOW" }));
  assert.equal(late.applied, false);
  assert.equal(session.fileName, null);

  const current = finishFileRead(session, latest, makeRom({ title: "FAST", code: "FAST" }));
  assert.equal(current.applied, true);
  assert.equal(session.fileName, "fast.gba");
  const plan = launch(session, "blob:fast");
  assert.equal(plan.ok, true);
  assert.match(plan.playerDocument, /fast\.gba \[FAST\]/);
  assert.doesNotMatch(plan.playerDocument, /slow\.gba/);
});

test("a failed read does not launch the previous ROM", () => {
  const session = createRomSession();
  const first = beginFileRead(session, "ok.gba");
  finishFileRead(session, first, makeRom());
  const second = beginFileRead(session, "broken.gba");
  const failed = finishFileRead(session, second, null, new Error("disk"));
  assert.equal(failed.applied, true);
  assert.equal(failed.ready, false);
  const plan = planLaunch(session, {
    createObjectUrl() {
      throw new Error("should not create a URL");
    },
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.error, "Could not read that file.");
});

test("Play with no file, a text file, a short file, or a bad header is rejected", () => {
  const none = planLaunch(createRomSession(), {
    createObjectUrl() {
      throw new Error("should not create a URL");
    },
  });
  assert.equal(none.ok, false);
  assert.equal(none.error, "Please select a .gba file first");

  const cases = [
    ["notes.txt", makeRom(), /ends in \.gba/],
    ["game.gba.txt", makeRom(), /ends in \.gba/],
    ["short.gba", new Uint8Array(10), /too small/],
    ["empty.gba", new Uint8Array(0), /too small/],
  ];
  for (const [name, bytes, pattern] of cases) {
    const found = inspectGbaRom(bytes, name);
    assert.equal(found.ok, false);
    assert.match(found.error, pattern);
  }

  const badMagic = makeRom();
  badMagic[0xb2] = 0;
  const magic = inspectGbaRom(badMagic, "bad.gba");
  assert.equal(magic.ok, false);
  assert.match(magic.error, /header byte/);

  const badSum = makeRom({ checksum: 0x00 });
  const sum = inspectGbaRom(badSum, "bad.gba");
  assert.equal(sum.ok, false);
  assert.match(sum.error, /checksum/);
});

test("a valid header is accepted case-insensitively and names the save", () => {
  const rom = makeRom({ title: "ASTROHAWK", code: "AHAW", extra: [1, 2, 3] });
  const info = inspectGbaRom(rom, "Folder\\Astrohawk.GBA");
  assert.equal(info.ok, true);
  assert.equal(info.title, "ASTROHAWK");
  assert.equal(info.gameCode, "AHAW");
  assert.equal(info.gameName, "Astrohawk.GBA [AHAW]");
  assert.equal(typeof info.gameId, "number");
  assert.ok(info.gameId > 0);

  const other = makeRom({ title: "ASTROHAWK", code: "AHAW", extra: [9] });
  assert.notEqual(inspectGbaRom(other, "Astrohawk.GBA").gameId, info.gameId);
});

test("each Play builds a fresh player and revokes the previous blob URL", () => {
  const session = createRomSession();
  const generation = beginFileRead(session, "one.gba");
  finishFileRead(session, generation, makeRom({ code: "ONE1" }));

  let created = 0;
  const first = planLaunch(session, {
    createObjectUrl() {
      created += 1;
      return "blob:one";
    },
  });
  const second = planLaunch(session, {
    createObjectUrl() {
      created += 1;
      return "blob:two";
    },
  });

  assert.equal(created, 2);
  assert.equal(first.revokeUrl, null);
  assert.equal(first.gameUrl, "blob:one");
  assert.equal(second.revokeUrl, "blob:one");
  assert.equal(second.gameUrl, "blob:two");
  assert.equal(second.gameId > 0, true);
  assert.match(second.playerDocument, new RegExp(EMULATOR_DATA_PATH.replace(/\//g, "\\/")));
  assert.match(second.playerDocument, /EJS_gameName = cfg\.gameName/);
  assert.match(second.playerDocument, /EJS_gameID = cfg\.gameId/);
  assert.match(second.playerDocument, /"core":"gba"/);
  assert.match(second.playerDocument, /blob:two/);
  assert.equal(second.playerDocument.includes("EJS_ready"), false);
  assert.equal(second.playerDocument.split("</script>").length - 1, 2);
});

test("player markup escapes a blob URL that contains a script close tag", () => {
  const doc = buildPlayerDocument({
    gameUrl: "blob:https://emulator.example/x</script><script>alert(1)</script>",
    gameName: "ok.gba",
    gameId: 7,
  });
  assert.equal(doc.split("</script>").length - 1, 2);
  assert.match(doc, /\\u003c\/script>/);
  assert.equal(doc.includes("<script>alert(1)"), false);

  const lineBreak = buildPlayerDocument({
    gameUrl: "blob:ok",
    gameName: "line\u2028break.gba",
    gameId: 7,
  });
  assert.equal(lineBreak.includes("\u2028"), false);
  assert.match(lineBreak, /\\u2028/);
});

test("a filename that contains markup cannot break out of the player script", () => {
  const session = createRomSession();
  const name = "bad</script>.gba";
  const generation = beginFileRead(session, name);
  finishFileRead(session, generation, makeRom({ code: "SAFE" }));
  const plan = launch(session, "blob:safe");
  assert.equal(plan.ok, true);
  assert.equal(plan.gameName.includes("<"), false);
  assert.equal(plan.playerDocument.split("</script>").length - 1, 2);
});

test("an empty file is rejected and does not create a ROM URL", () => {
  const { ready, plan } = launchRefused(new Uint8Array(0), "empty.gba");
  assert.equal(ready.applied, true);
  assert.equal(ready.ready, true);
  assert.equal(plan.ok, false);
  assert.equal(plan.error, "This file is too small to be a GBA ROM.");
});

test("a ROM truncated inside the header is rejected and does not create a ROM URL", () => {
  // 0xB3 includes the required 0x96 byte. Every length below 0xC0 ends
  // inside the 192-byte header. 0xBF still contains the checksum byte.
  for (const length of [1, 0xb3, 0xbf]) {
    const bytes = new Uint8Array(length);
    if (length > 0xb2) bytes[0xb2] = 0x96;
    const { plan } = launchRefused(bytes, "truncated.gba");
    assert.equal(plan.ok, false);
    assert.equal(plan.error, "This file is too small to be a GBA ROM.");
  }
});

test("a valid header cut after the checksum byte is still too small to launch", () => {
  // 0xBE keeps the fixed byte and a matching checksum, and drops the
  // reserved bytes that finish the 192-byte header.
  const full = makeRom({ extra: [1, 2, 3, 4] });
  const cut = full.subarray(0, 0xbe);
  assert.equal(cut.length, 0xbe);
  assert.equal(cut[0xb2], 0x96);
  assert.equal(cut[0xbd], specChecksum(cut));
  assert.equal(full.buffer, cut.buffer);
  const { plan } = launchRefused(cut, "cut.gba");
  assert.equal(plan.ok, false);
  assert.equal(plan.error, "This file is too small to be a GBA ROM.");
});

test("Play rejects a bad extension, fixed byte, or checksum without a ROM URL", () => {
  const badMagic = makeRom();
  badMagic[0xb2] = 0;
  const badSum = makeRom({ checksum: 0x00 });
  const cases = [
    ["notes.txt", makeRom(), "Select a file that ends in .gba."],
    ["game.gba.bak", makeRom(), "Select a file that ends in .gba."],
    ["bad.gba", badMagic, "This file is not a GBA ROM (missing required header byte)."],
    ["sum.gba", badSum, "This GBA ROM has an invalid header checksum."],
  ];
  for (const [name, bytes, error] of cases) {
    const { ready, plan } = launchRefused(bytes, name);
    assert.equal(ready.ready, true, name);
    assert.equal(plan.ok, false, name);
    assert.equal(plan.error, error, name);
  }
});

test("an invalid file does not revoke the blob URL of the ROM already playing", () => {
  const session = createRomSession();
  const firstGen = beginFileRead(session, "ok.gba");
  finishFileRead(session, firstGen, makeRom());
  const first = launch(session, "blob:ok");
  assert.equal(first.ok, true);
  assert.equal(session.activeUrl, "blob:ok");

  const secondGen = beginFileRead(session, "bad.gba");
  finishFileRead(session, secondGen, new Uint8Array(10));
  let created = 0;
  const second = planLaunch(session, {
    createObjectUrl() {
      created += 1;
      return "blob:bad";
    },
  });
  assert.equal(second.ok, false);
  assert.equal(second.error, "This file is too small to be a GBA ROM.");
  assert.equal(created, 0);
  assert.equal(session.activeUrl, "blob:ok");
  assert.equal("revokeUrl" in second, false);
});

test("truncating the read buffer after a successful read does not change the launched ROM", () => {
  const session = createRomSession();
  const bytes = makeRom({ extra: [1, 2, 3, 4] });
  const snapshot = new Uint8Array(bytes);
  const generation = beginFileRead(session, "kept.gba");
  const ready = finishFileRead(session, generation, bytes);
  assert.equal(ready.ready, true);
  assert.notEqual(session.bytes, bytes);
  bytes.fill(0);
  assert.equal(bytes[0xb2], 0);

  let launched = null;
  const plan = planLaunch(session, {
    createObjectUrl(value) {
      launched = value;
      return "blob:kept";
    },
  });
  assert.equal(plan.ok, true, plan.error);
  assert.equal(plan.gameUrl, "blob:kept");
  assert.notEqual(launched, bytes);
  assert.deepEqual(launched, snapshot);
});

test("a detached ROM buffer is a failed read and does not create a ROM URL", () => {
  const bytes = makeRom();
  structuredClone(bytes, { transfer: [bytes.buffer] });
  const { ready, plan } = launchRefused(bytes, "detached.gba");
  assert.equal(ready.applied, true);
  assert.equal(ready.ready, false);
  assert.equal(plan.ok, false);
  assert.equal(plan.error, "Could not read that file.");
});

test("an oversized ROM header is rejected and does not create a ROM URL", () => {
  const limit = 32 * 1024 * 1024;
  const { plan } = launchRefused(romOfSize(limit + 1), "huge.gba");
  assert.equal(plan.ok, false);
  assert.equal(plan.error, "This GBA ROM is larger than 32 MiB.");
});

test("a ROM of exactly 32 MiB is accepted by planLaunch", () => {
  const limit = 32 * 1024 * 1024;
  const session = createRomSession();
  const generation = beginFileRead(session, "limit.gba");
  const ready = finishFileRead(session, generation, romOfSize(limit));
  assert.equal(ready.applied, true);
  assert.equal(ready.ready, true);

  let created = 0;
  const plan = planLaunch(session, {
    createObjectUrl(bytes) {
      created += 1;
      assert.equal(bytes.length, limit);
      return "blob:limit";
    },
  });
  assert.equal(plan.ok, true, plan.error);
  assert.equal(created, 1);
  assert.equal(plan.gameUrl, "blob:limit");
  assert.match(plan.playerDocument, /blob:limit/);
});

function playingSession() {
  const session = createRomSession();
  const generation = beginFileRead(session, "live.gba");
  finishFileRead(session, generation, makeRom());
  const plan = planLaunch(session, {
    createObjectUrl() {
      return "blob:live";
    },
  });
  assert.equal(plan.ok, true, plan.error);
  return session;
}

function quotaError() {
  const error = new Error("quota");
  error.name = "QuotaExceededError";
  return error;
}

test("teardown clears the session and the active ROM URL", async () => {
  const { teardownSession } = await import("../src/gba-session.js");
  assert.equal(typeof teardownSession, "function");
  const session = playingSession();
  const removed = [];
  let deleted = null;
  const result = teardownSession(session, {
    localStorage: {
      length: 2,
      key(index) {
        return ["other-app", "gba-rom-session:3:1"][index];
      },
      removeItem(key) {
        removed.push(key);
      },
    },
    indexedDB: {
      deleteDatabase(name) {
        deleted = name;
        return {};
      },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.storageError, null);
  assert.equal(result.revokeUrl, "blob:live");
  assert.equal(deleted, "gba-rom-session");
  assert.deepEqual(removed.slice().sort(), ["gba-rom-session", "gba-rom-session:3:1"]);
  assert.equal(removed.includes("other-app"), false);
  assert.equal(session.bytes, null);
  assert.equal(session.fileName, null);
  assert.equal(session.pendingName, null);
  assert.equal(session.activeUrl, null);
  assert.equal(session.readError, null);
});

test("teardown still clears the session when localStorage raises quota", async () => {
  const { teardownSession } = await import("../src/gba-session.js");
  const session = playingSession();
  const removed = [];
  const result = teardownSession(session, {
    localStorage: {
      length: 1,
      key() {
        return "gba-rom-session:7:1";
      },
      removeItem(key) {
        removed.push(key);
        throw quotaError();
      },
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.revokeUrl, "blob:live");
  assert.equal(result.storageError, "Could not clear saved data because storage is full.");
  assert.equal(removed.length > 0, true);
  assert.equal(session.bytes, null);
  assert.equal(session.fileName, null);
  assert.equal(session.activeUrl, null);
  const plan = planLaunch(session, {
    createObjectUrl() {
      throw new Error("should not create a URL");
    },
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.error, "Please select a .gba file first");

  const legacy = teardownSession(createRomSession(), {
    localStorage: {
      removeItem() {
        const error = new Error("quota");
        error.code = 22;
        throw error;
      },
    },
  });
  assert.equal(legacy.ok, false);
  assert.equal(legacy.storageError, "Could not clear saved data because storage is full.");
});

test("teardown still clears the session when localStorage and IndexedDB are unavailable", async () => {
  const { teardownSession } = await import("../src/gba-session.js");
  const session = playingSession();
  const result = teardownSession(session, { localStorage: null, indexedDB: null });
  assert.equal(result.ok, false);
  assert.equal(result.revokeUrl, "blob:live");
  assert.equal(result.storageError, "Could not clear saved data because storage is unavailable.");
  assert.equal(session.bytes, null);
  assert.equal(session.activeUrl, null);
  assert.equal(session.fileName, null);

  let deleted = null;
  const denied = teardownSession(playingSession(), {
    indexedDB: {
      deleteDatabase(name) {
        deleted = name;
        const error = new Error("blocked");
        error.name = "SecurityError";
        throw error;
      },
    },
  });
  assert.equal(deleted, "gba-rom-session");
  assert.equal(denied.ok, false);
  assert.equal(denied.storageError, "Could not clear saved data because storage is unavailable.");
  assert.equal(denied.revokeUrl, "blob:live");
});

test("teardown still asks IndexedDB to delete when localStorage quota fails first", async () => {
  const { teardownSession } = await import("../src/gba-session.js");
  const session = playingSession();
  let deleted = 0;
  const quota = new Error("quota");
  quota.name = "QuotaExceededError";
  const result = teardownSession(session, {
    localStorage: {
      removeItem() {
        throw quota;
      },
    },
    indexedDB: {
      deleteDatabase() {
        deleted += 1;
        return { error: quota };
      },
    },
  });
  assert.equal(deleted, 1);
  assert.equal(result.ok, false);
  assert.equal(result.storageError, "Could not clear saved data because storage is full.");
  assert.equal(result.revokeUrl, "blob:live");
  assert.equal(session.bytes, null);
  assert.equal(session.activeUrl, null);
});

test("teardown ignores a ROM read that finishes after the session is cleared", async () => {
  const { teardownSession } = await import("../src/gba-session.js");
  const session = createRomSession();
  const generation = beginFileRead(session, "late.gba");
  const ended = teardownSession(session, {});
  assert.equal(ended.ok, true);
  assert.equal(ended.revokeUrl, null);
  const late = finishFileRead(session, generation, makeRom());
  assert.equal(late.applied, false);
  assert.equal(session.bytes, null);
  assert.equal(session.fileName, null);
  assert.equal(session.pendingName, null);
  const plan = planLaunch(session, {
    createObjectUrl() {
      throw new Error("should not create a URL");
    },
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.error, "Please select a .gba file first");
});

test("the page no longer calls EJS_ready or the floating jsDelivr build", () => {
  const html = readFileSync(join(root, "index.html"), "utf8");
  const main = readFileSync(join(root, "src/main.js"), "utf8");
  const session = readFileSync(join(root, "src/gba-session.js"), "utf8");
  const source = `${html}\n${main}\n${session}`;
  assert.equal(/EJS_ready\s*\(/.test(source), false);
  assert.equal(source.includes("jsdelivr"), false);
  assert.match(html, /src="\.\/src\/main\.js"/);
  assert.match(session, /cdn\.emulatorjs\.org\/stable\/data\//);
});
