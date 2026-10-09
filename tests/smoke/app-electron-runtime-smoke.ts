import { spawnElectron } from "../support/electron-child";
/** Real packaged App: runtime, sandbox, stub chat, PDF artifact and tray quit. */
import { strict as assert } from "node:assert";
import { type ChildProcess } from "node:child_process";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { freePort } from "../support/native-app-server.ts";
import { smokeElectronArgs } from "../support/smoke-browser.ts";
import { electronMain } from "../support/electron-main-cdp.ts";
import { electronPage, type ElectronPage } from "../support/electron-page-cdp.ts";
import { updateFixtureResponse } from "../support/update-work-fixture.ts";
import { FIRST_RUN_CONSENT_VERSION } from "../../packages/butler-app/client/ui/src/app/onboarding.ts";

const executablePath = process.env.BUTLER_SMOKE_APP_EXECUTABLE;
assert.ok(executablePath, "Set BUTLER_SMOKE_APP_EXECUTABLE to the packaged App executable");
const dir = mkdtempSync(join(tmpdir(), "butler-electron-runtime-"));
const home = join(dir, "home"), data = join(dir, "data");
mkdirSync(home); mkdirSync(data);
const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const { content } = updateFixtureResponse(await request.json());
  return Response.json({ id: "runtime-smoke", object: "chat.completion", created: 0, model: "stub",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] });
} });
writeFileSync(join(data, "butler.config.json"), JSON.stringify({
  user: { name: "Smoke", language: "en" }, system: { defaultModel: "local/stub" },
  models: { local: [{ model_id: "stub", display_name: "Stub",
    server_url: `http://127.0.0.1:${provider.port}`, context_window_tokens: 128000 }] },
  metrics: { enabled: false },
}));
const completedAt = new Date().toISOString();
mkdirSync(join(data, "personalization"));
writeFileSync(join(data, "personalization/onboarding.json"), JSON.stringify({
  schema: "butler.first_chat_onboarding.v1", status: "complete", gateway: "any", fields: {},
  skipped_fields: [], created_at: completedAt, updated_at: completedAt, completed_at: completedAt,
}));
let child: ChildProcess | undefined;
let page: ElectronPage | undefined;
let agentPid = 0;
const logs: string[] = [];
const inspectorPort = await freePort();

function running(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitUntil(read: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await read()) return;
    await new Promise(done => setTimeout(done, 100));
  }
  throw new Error(`Timed out: ${label}`);
}

const main = <T>(expression: string, queryInstances = false) => electronMain<T>(inspectorPort, expression, queryInstances);

/** Valid one-page PDF served through the real signed message-file route. */
function pdf(): number[] {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  const stream = "BT /F1 18 Tf 30 100 Td (Electron PDF smoke) Tj ET\n";
  objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}endstream`);
  let text = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(text.length); text += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = text.length;
  text += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}`;
  text += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return [...new TextEncoder().encode(text)];
}

async function click(name: string): Promise<void> {
  const selector = `Array.from(document.querySelectorAll('button,[role="button"]')).find(e =>
    (e.getAttribute('aria-label') || e.textContent).trim() === ${JSON.stringify(name)})`;
  await waitUntil(() => page!.expression(`Boolean(${selector})`), `button ${name}`);
  await page!.expression(`(${selector}).click()`);
}

try {
  const started = Date.now();
  const debugPort = await freePort();
  // Electron uses its production process model. --single-process is only a
  // restricted Playwright Chromium workaround and crashes Electron 44 on macOS.
  child = spawnElectron(resolve(executablePath), [`--inspect=${inspectorPort}`, `--remote-debugging-port=${debugPort}`, ...smokeElectronArgs()], { env: {
    ...process.env, HOME: home, BUTLER_DATA: data, TMPDIR: dir,
    BUTLER_APP_ELECTRON_USER_DATA_DIR: join(dir, "profile"), BUTLER_APP_SERVER_PORT: String(await freePort()),
    BUTLER_APP_ALLOW_PRECONFIRMED_E2E_QUIT: "1", BUTLER_E2E_TIER: "stub",
    BUTLER_E2E_EMBED_SOURCES: "http://127.0.0.1:9", BUTLER_APP_DISABLE_SHELL_REGISTRATION: "1",
  }, onOutput: bytes => logs.push(String(bytes)) });
  page = await electronPage(debugPort);
  await page.waitForFunction(() => document.readyState === "complete" && Boolean(window.butlerApp));
  const versions = await main<{ electron: string; chrome: string; node: string }>(
    "({electron:process.versions.electron,chrome:process.versions.chrome,node:process.versions.node})");
  assert.match(versions.electron, /^44\./u); assert.match(versions.chrome, /^152\./u); assert.match(versions.node, /^24\./u);
  const electron = "process.getBuiltinModule('module').createRequire(process.resourcesPath+'/app/package.json')('electron')";
  const windowExpression = `${electron}.BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/index.html'))`;
  const security = await main<Record<string, boolean>>(`(() => {
    const p = ${windowExpression}.webContents.getLastWebPreferences();
    return {contextIsolation:p.contextIsolation,sandbox:p.sandbox,nodeIntegration:p.nodeIntegration};
  })()`);
  assert.equal(await page.expression("typeof process !== 'undefined' || typeof require !== 'undefined'"), false);
  assert.deepEqual(security, { contextIsolation: true, sandbox: true, nodeIntegration: false });
  await waitUntil(async () => (await page!.expression<{ ok: boolean }>("window.butlerApp.health()")).ok, "Agent healthy");
  const instance = JSON.parse(readFileSync(join(data, "app/runtime/foreground/instance.json"), "utf8"));
  agentPid = instance.agent_host_pid;
  await page.expression(`window.butlerApp.updateSettings(${JSON.stringify({ language: "en", onboarding: {
    consent_version: FIRST_RUN_CONSENT_VERSION, accepted_at: completedAt, completed_at: completedAt,
  } })})`);
  await page.reload();
  await page.waitForFunction(() => Boolean(document.querySelector('[data-test-class="workspace"]')));
  const startupMs = Date.now() - started;
  const { session } = await page.expression<{ session: { id: string } }>("window.butlerApp.createSession({kind:'chat',title:'Runtime smoke'})");
  await page.expression(`window.butlerApp.sendMessage(${JSON.stringify({ chatId: session.id,
    text: "Reply with exactly the word: done", clientMessageId: crypto.randomUUID(), model: "local/stub" })})`);
  await waitUntil(async () => (await page!.expression<{ turns: Array<{ state: string }> }>(
    `window.butlerApp.listTurns({chatId:${JSON.stringify(session.id)}})`)).turns.some(turn => turn.state === "delivered"), "stub delivered");
  // Only the relationship is seeded in disposable DATA. Upload, signed URL,
  // artifact projection, UI and Chromium PDF rendering all use real paths.
  const upload = await page.expression<{ file: { file_id: string } }>(`window.butlerApp.uploadMessageFile({
    name:'runtime.pdf',mimeType:'application/pdf',bytes:new Uint8Array(${JSON.stringify(pdf())}),sessionId:${JSON.stringify(session.id)}})`);
  const db = new Database(join(data, "app-server/butler-client.sqlite"));
  const message = db.query("SELECT id,text FROM messages WHERE chat_id=? AND role='assistant' ORDER BY rowid DESC LIMIT 1")
    .get(session.id) as { id: string; text: string };
  assert.equal(message.text.trim(), "done");
  db.query("INSERT INTO message_attachments(message_id,file_id,position) VALUES(?,?,0)").run(message.id, upload.file.file_id);
  db.close();
  await page.reload();
  await click("Runtime smoke");
  if (await page.expression("Array.from(document.querySelectorAll('button')).some(b=>b.getAttribute('aria-label')==='Show right panel')")) await click("Show right panel");
  await click("Artifacts");
  await page.waitForFunction(() => Array.from(document.querySelectorAll('[data-slot="document-tile"]')).some(e => e.textContent?.includes("runtime.pdf")));
  await page.expression("Array.from(document.querySelectorAll('[data-slot=\"document-tile\"]')).find(e=>e.textContent.includes('runtime.pdf')).click()");
  await page.waitForFunction(() => Boolean(document.querySelector('[data-test-class="artifact-viewer"] iframe')));
  await waitUntil(() => main<boolean>(`${windowExpression}.webContents.mainFrame.framesInSubtree.some(f=>f.url.startsWith('chrome-extension://')&&f.url.includes('index.html'))`), "PDF viewer frame");
  await page.waitForFunction(() => {
    const frame = document.querySelector('[data-test-class="artifact-viewer"] iframe');
    const bounds = frame?.getBoundingClientRect();
    return bounds && bounds.width > 0 && bounds.height > 0 && bounds.left >= 0 && bounds.right <= innerWidth;
  });
  const pdfFrame = `${windowExpression}.webContents.mainFrame.framesInSubtree.find(f=>f.url.startsWith('chrome-extension://')&&f.url.includes('index.html'))`;
  const pdfStateExpression = `${pdfFrame}.executeJavaScript("(() => {const v=document.querySelector('pdf-viewer');const t=v?.shadowRoot?.querySelector('viewer-toolbar');return {pages:t?.docLength,documentPages:v?.documentDimensions?.pageDimensions?.length,loadState:v?.loadState_}})()")`;
  await waitUntil(async () => {
    const state = await main<{ pages: number; documentPages: number }>(pdfStateExpression);
    return state.pages === 1 && state.documentPages === 1;
  }, "PDF page rendered");
  if (process.env.BUTLER_SMOKE_SCREENSHOT) {
    const png = await main<string>(`${windowExpression}.webContents.capturePage().then(image=>image.toPNG().toString('base64'))`);
    writeFileSync(process.env.BUTLER_SMOKE_SCREENSHOT, Buffer.from(png, "base64"));
  }
  assert.ok(running(agentPid));
  const trays = await main<Array<{ width: number; height: number }>>(`${electron}.Tray.prototype`, true);
  assert.equal(trays.length, 1, "foreground App owns one live tray");
  assert.ok(trays[0]!.width > 0 && trays[0]!.height > 0, "tray has visible native bounds");
  await main(`${windowExpression}.close()`);
  assert.equal(await main(`${windowExpression}.isVisible()`), false);
  assert.ok(running(agentPid), "tray close retains Agent");
  await page.expression("window.butlerApp.quitApp({confirmed:true})");
  await waitUntil(() => child!.exitCode !== null || child!.signalCode !== null, "App quit");
  assert.equal(child.exitCode, 0);
  await waitUntil(() => !running(agentPid), "quit stops Agent");
  console.log(JSON.stringify({ ok: true, versions, security, startupMs, stubReply: message.text,
    pdfViewer: true, trayClose: true, cleanQuit: true }));
} catch (error) {
  console.error(logs.join("").slice(-8000));
  throw error;
} finally {
  page?.close();
  if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  for (const pid of [agentPid]) if (running(pid)) process.kill(pid, "SIGTERM");
  provider.stop(true);
  await new Promise(done => setTimeout(done, 1500));
  if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
}
