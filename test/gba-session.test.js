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
