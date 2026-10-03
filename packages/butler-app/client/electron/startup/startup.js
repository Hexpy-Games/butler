// A local, dependency-free renderer. The poster is decoded before the native reveal.
const bridge = window.butlerStartup;
const query = new URLSearchParams(location.search);
const labels = {
  ko: { starting: "버틀러를 준비합니다…", agent: "에이전트를 시작합니다…", migration: "이전 버전을 정리합니다…", renderer: "화면을 준비합니다…", failed: "시작하지 못했습니다.", retry: "다시 시도", logs: "로그 보기" },
  en: { starting: "Preparing Butler…", agent: "Starting agent…", migration: "Preparing upgrade…", renderer: "Preparing workspace…", failed: "Could not start Butler.", retry: "Retry", logs: "View logs" },
};
let state = { stage: "starting", failed: false, language: query.get("language") ?? navigator.language };
function render(next) {
  state = { ...state, ...next };
  const copy = labels[state.language.startsWith("ko") ? "ko" : "en"];
  document.documentElement.lang = state.language;
  document.documentElement.dataset.motion = state.reducedMotion ? "reduced" : "auto";
  document.documentElement.dataset.failed = String(state.failed);
  const status = document.getElementById("status");
  status.textContent = state.failed ? copy.failed : copy[state.stage] ?? copy.starting;
  status.setAttribute("role", state.failed ? "alert" : "status");
  document.getElementById("actions").hidden = !state.failed;
  for (const action of ["retry", "logs"]) document.getElementById(action).textContent = copy[action];
}
for (const action of ["retry", "logs"]) document.getElementById(action).onclick = () => {
  if (bridge) void bridge.action(action);
  else if (query.get("preview") === "true") parent.postMessage({ startupAction: action }, location.origin);
};
bridge?.subscribe(render);
render({ reducedMotion: query.get("motion") === "reduced",
  ...(query.get("preview") === "true" ? { stage: query.get("stage"), failed: query.get("stage") === "failed" } : {}),
});
const wallpaper = document.getElementById("wallpaper");
const poster = query.get("poster");
// Only bundled posters and main-process supplied raster data; no remote loads.
wallpaper.src = poster && (/^startup\/posters\/[a-z.-]+\.png$/.test(poster) || /^data:image\/(png|jpeg|webp);base64,/.test(poster))
  ? poster : "startup/posters/butler.bloom.dark.png";
async function painted() {
  await wallpaper.decode().catch(async () => {
    wallpaper.src = "startup/posters/butler.bloom.dark.png";
    await wallpaper.decode();
  });
  await document.getElementById("mark").decode();
  render(await bridge?.state() ?? {});
  requestAnimationFrame(() => requestAnimationFrame(() => {
    document.documentElement.dataset.painted = "true";
    bridge?.painted();
  }));
}
void painted();
