import { beginFileRead, createRomSession, finishFileRead, planLaunch } from "./gba-session.js";

const session = createRomSession();
const fileInput = document.getElementById("rom");
const startBtn = document.getElementById("start");
const game = document.getElementById("game");
const status = document.getElementById("status");

function setStatus(message) {
  status.textContent = message || "";
}

fileInput.addEventListener("change", async (event) => {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  const generation = beginFileRead(session, file.name);
  startBtn.textContent = `Reading ${file.name}...`;
  setStatus("");
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const result = finishFileRead(session, generation, bytes);
    if (!result.applied) return;
    startBtn.textContent = `Play ${result.fileName}`;
  } catch (error) {
    const result = finishFileRead(session, generation, null, error);
    if (!result.applied) return;
    startBtn.textContent = "Load & Play";
    setStatus(session.readError);
  }
});

startBtn.addEventListener("click", () => {
  const plan = planLaunch(session, {
    createObjectUrl(bytes) {
      return URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
    },
  });
  if (!plan.ok) {
    setStatus(plan.error);
    return;
  }
  setStatus("");
  const iframe = document.createElement("iframe");
  iframe.className = "player";
  iframe.title = plan.gameName;
  iframe.allow = "fullscreen; gamepad";
  iframe.srcdoc = plan.playerDocument;
  game.replaceChildren(iframe);
  if (plan.revokeUrl) URL.revokeObjectURL(plan.revokeUrl);
});
