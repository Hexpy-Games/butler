import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { browserAgentApp, waitBrowser } from "../../../../tests/support/browser-agent-app.ts";
import { liveTrackedProcessIds, nativeAgentExecutable, spawnTrackedProcess, stopAllTrackedProcesses } from "../../../../tests/support/native-app-server.ts";
import { report } from "./report.ts";
import { seed, type Box, type Scene } from "./scene.ts";
import { shots } from "./shots.ts";

const args = Bun.argv.slice(2);
const value = (flag: string, fallback?: string) => {
  const index = args.indexOf(flag);
  return index < 0 ? fallback : args[index + 1];
};
const output = value("--out");
if (!output) throw new Error("usage: run.ts <scene…> --out <dir> [--sizes 1280x800,390x844] [--themes light,dark] [--scale 2]");
const out = resolve(output);
const names: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith("--")) { i++; continue; }
  names.push(args[i]);
}
if (!names.length) throw new Error("At least one scene is required");
const sizes = value("--sizes", "1280x800,390x844")!.split(",");
const themes = value("--themes", "light,dark")!.split(",");
const scale = Number(value("--scale", "2"));
if (!Number.isFinite(scale) || scale <= 0 || sizes.some(size => !/^[1-9]\d*x[1-9]\d*$/u.test(size)) || themes.some(theme => !["light", "dark"].includes(theme))) throw new Error("Invalid size, theme or scale");
for (const dir of ["electron", "gpui", "diff", "logs"]) mkdirSync(join(out, dir), { recursive: true });
const target = process.env.CARGO_TARGET_DIR ?? resolve("packages/butler-shell/target");
const shotsBinary = process.env.BUTLER_SHELL_SHOTS_EXECUTABLE ?? join(target, "debug/butler-shell-shots");
const diffBinary = process.env.BUTLER_PARITY_DIFF_EXECUTABLE ?? join(target, "debug/parity-diff");
nativeAgentExecutable();
for (const path of [shotsBinary, diffBinary, process.env.BUTLER_SMOKE_ELECTRON_EXECUTABLE,
  join(process.env.BUTLER_SMOKE_RENDERER_DIST ?? resolve("packages/butler-app/client/ui/dist"), "index.html")]) {
  if (!path || !existsSync(path)) throw new Error(`Missing capture prerequisite: ${path ?? "BUTLER_SMOKE_ELECTRON_EXECUTABLE"}`);
}
type App = Awaited<ReturnType<typeof browserAgentApp>>;

const answer = `## 회의 준비 · Meeting notes

담당자와 검토 일정을 아래와 같이 정리했습니다. Please review the owner and date before sharing.

- 키보드 탐색과 포커스 표시를 확인합니다.
- 모바일 화면에서 긴 문장을 읽어 봅니다.
- 변경 사항을 팀과 공유합니다.

\`\`\`json
{ "theme": "dark", "reduce_motion": true }
\`\`\`

| 항목 · Item | 담당 · Owner | 일정 · Date |
| --- | --- | --- |
| 접근성 검토 | Design | Monday |
| 출시 확인 | Engineering | Friday |

다음 회의에서는 검토 결과와 남은 질문을 함께 확인하겠습니다.`;

async function capture(app: App, scene: Scene, anchors: Scene["anchors"], size: string, theme: string) {
  const [width, height] = size.split("x").map(Number);
  const name = `${scene.name}-${size}-${theme}`;
  const cdp = <T>(method: string, params: unknown) => app.main<T>(`${app.win}.webContents.debugger.sendCommand(${JSON.stringify(method)},${JSON.stringify(params)})`);
  await app.gateway.api("/settings", { method: "PATCH", body: JSON.stringify({ appearance_theme: theme, reduce_motion: true }) });
  await app.main(`${app.win}.setContentSize(${width},${height})`);
  await cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile: false });
  await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }, { name: "prefers-reduced-motion", value: "reduce" }] });
  await app.page.reload();
  const title = "chat" in scene.open ? scene.open.chat : "새 대화";
  await waitBrowser(() => app.page.expression(`Boolean([...document.querySelectorAll('[role="button"],button')].find(el=>el.getAttribute('aria-label')===${JSON.stringify(title)}))`), `chat row ${title}`);
  const visible = await app.page.expression<boolean>(`[...document.querySelectorAll('[role="button"],button')].some(el => {
    const b=el.getBoundingClientRect();return el.getAttribute('aria-label')===${JSON.stringify(title)} && b.width>0 && b.height>0 && b.x>=0 && b.right<=innerWidth;
  })`);
  if (!visible) await app.page.clickRole("button", "사이드바 보기");
  if ("chat" in scene.open) await app.page.clickRole("button", title);
  else await app.click(title);
  await app.page.expression("document.fonts.ready.then(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))");
  const boxes = await app.page.expression<Box[]>(`(${JSON.stringify(anchors)}).flatMap(({anchor,electron})=>{
    const el=document.querySelector(electron);if(!el)return [];
    const b=el.getBoundingClientRect();if(!b.width||!b.height)return [];
    return [{anchor,x:b.x,y:b.y,w:b.width,h:b.height}];
  })`);
  const png = await cdp<{ data: string }>("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(join(out, "electron", `${name}.png`), Buffer.from(png.data, "base64"));
  writeFileSync(join(out, "electron", `${name}.layout.json`), JSON.stringify(boxes, null, 2));
  return name;
}

async function runScene(scene: Scene) {
  let offered = false;
  const app = await browserAgentApp(join(out, "logs", scene.name), request => {
    if (scene.name !== "approval" || offered || !request.stream || !Array.isArray(request.body.tools) || !request.body.tools.length) return null;
    offered = true;
    return { name: "run_command", arguments: { command: "printf '검토 자료를 저장합니다\\n'", state_effect: "mutation", summary: "검토 자료 저장" } };
  }, process.env.BUTLER_SMOKE_RENDERER_DIST, { stubReply: request => request.stream ? answer : "{}" });
  try {
    writeFileSync(join(out, "logs", `${scene.name}-agent.pid`), String(app.gateway.pid));
    writeFileSync(join(out, "logs", `${scene.name}-electron.pid`), String(await app.main<number>("process.pid")));
    writeFileSync(join(out, "logs", `${scene.name}-tracked-pids.json`), JSON.stringify(liveTrackedProcessIds()));
    const seeded = await seed(app.gateway, scene);
    if (scene.name === "approval") await waitBrowser(async () => {
      const view = await app.gateway.api<{ authority_requests?: unknown[] }>(`/session-view?session_id=${seeded.chat}`);
      return Boolean(view.authority_requests?.length);
    }, "approval request");
    const anchors = await seeded.anchors();
    await app.main(`${app.win}.webContents.debugger.attach('1.3')`);
    for (const theme of themes) for (const size of sizes) {
      const name = await capture(app, scene, anchors, size, theme);
      await shots(shotsBinary, out, name, app.gateway.butlerData, scale, size, theme === "dark", "chat" in scene.open ? seeded.chat : undefined);
    }
  } finally {
    await app.stop();
  }
}

async function diff() {
  const log = Bun.file(join(out, "logs", "pixel-diff.log"));
  const fd = openSync(log.name!, "w");
  const child = spawnTrackedProcess(diffBinary, [join(out, "electron"), join(out, "gpui"), join(out, "diff")], { stdio: ["ignore", fd, fd] });
  closeSync(fd);
  try {
    writeFileSync(join(out, "logs", "parity-diff.pid"), String(child.pid));
    const code = await new Promise<number | null>((done, fail) => { child.child.once("exit", done); child.child.once("error", fail); });
    console.log(await log.text());
    if (code !== 0) throw new Error(`parity-diff exited ${code}`);
  } finally { await child.stop(); }
}

try {
  for (const name of names) {
    if (!/^[a-z0-9-]+$/u.test(name)) throw new Error(`Invalid scene: ${name}`);
    const scene = JSON.parse(readFileSync(new URL(`./scenes/${name}.json`, import.meta.url), "utf8")) as Scene;
    await runScene(scene);
  }
  await diff();
  report(out);
  console.log(`Report: ${join(out, "report.html")}`);
} finally {
  await stopAllTrackedProcesses();
}
