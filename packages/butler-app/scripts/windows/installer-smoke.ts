/** Disposable-runner E2E: real Setup, Settings update, shell integration, uninstall. */
import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { electronPage, type ElectronPage } from "../../../../tests/support/electron-page-cdp.ts";
import { freePort } from "../../../../tests/support/native-app-server.ts";
import { alive, assertShortcuts, bridge, click, ownedProcesses, powershell, readJson, shortcutPaths, waitFor } from "./installer-smoke-support.ts";

if (process.platform !== "win32" || process.env.GITHUB_ACTIONS !== "true" || process.env.RUNNER_ENVIRONMENT !== "github-hosted") {
  throw new Error("Registry/shortcut/installer smoke is restricted to disposable GitHub-hosted runners");
}
const release = resolve(process.argv[2]);
const second = resolve(process.argv[3]);
const from = "0.1.0-preview.90", to = "0.1.0-preview.91";
const root = mkdtempSync(join(tmpdir(), "butler-installer-e2e-"));
const data = join(root, "data");
const owned = new Set<number>();
let page: ElectronPage | null = null;
let calls = 0;
let uninstalled = false;
let phase = "one-click install";
const manifest = readJson(join(second, "app-update-manifest.json"))!;
const packageName = manifest.artifacts[0].artifact_url.split("/").at(-1);
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
  const path = new URL(request.url).pathname;
  if (path === "/v1/responses") {
    const body = await request.json();
    assert.ok(JSON.stringify(body).includes("Reply with Windows update ready."));
    calls++;
    return Response.json({ id: "resp_installer", object: "response", status: "completed", model: "gpt-6-luna",
      output: [{ type: "message", id: "msg_installer", role: "assistant", status: "completed",
        content: [{ type: "output_text", text: "Windows update ready.", annotations: [] }] }],
      usage: { input_tokens: 100, output_tokens: 4, total_tokens: 104 } });
  }
  if (path === `/${packageName}`) return new Response(Bun.file(join(second, packageName)));
  if (path === "/manifest.json") return Response.json({ ...manifest, artifacts: manifest.artifacts.map((item: any) => ({
    ...item, artifact_url: `http://127.0.0.1:${server.port}/${packageName}`,
  })) });
  return new Response(null, { status: 404 });
} });
const debugPort = await freePort();
const agentPort = await freePort();
const env = { ...process.env, HOME: join(root, "home"), BUTLER_DATA: data,
  LOCALAPPDATA: join(root, "local"), APPDATA: join(root, "roaming"), BUTLER_SECRET_STORE: "file",
  BUTLER_APP_ELECTRON_USER_DATA_DIR: join(root, "profile"), BUTLER_APP_SMOKE_DEBUG_PORT: String(debugPort),
  BUTLER_APP_SERVER_PORT: String(agentPort), BUTLER_E2E_TIER: "stub", BUTLER_PROVIDER_QUOTA_POLLING: "0",
  OPENAI_API_KEY: "e2e-not-real", OPENAI_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
  ELECTRON_ENABLE_LOGGING: "1", ELECTRON_LOG_FILE: join(root, "electron.log"),
  BUTLER_APP_UPDATE_MANIFEST: `http://127.0.0.1:${server.port}/manifest.json`, BUTLER_APP_ALLOW_PRECONFIRMED_E2E_QUIT: "1",
};
const installed = join(powershell("[Environment]::GetFolderPath('LocalApplicationData')", env), "butler-app");
const stub = join(installed, "Butler.exe");
const updater = join(installed, "Update.exe");
const shortcuts = [join(env.APPDATA, "Microsoft/Windows/Start Menu/Programs/Butler.lnk"), shortcutPaths()[1]!];
const started = Date.now();
try {
  prepare();
  await oneClickLaunch();
  phase = "silent install";
  run(join(release, `ButlerSetup-${from}-x64.exe`), ["--silent"]);
  await waitFor(() => existsSync(stub) && existsSync(updater), "per-user install");
  await waitFor(() => shortcuts.every(path => existsSync(path)), "Start Menu and Desktop shortcuts");
  assertShortcuts(shortcuts, true);
  shellProof();
  // Silent Squirrel installation does not necessarily start the first-run app.
  const app = spawn(stub, [], { env, stdio: ["ignore", "pipe", "pipe"] });
  const appLog: string[] = [];
  for (const stream of [app.stdout, app.stderr]) stream?.on("data", chunk => appLog.push(String(chunk)));
  app.on("exit", (code, signal) => console.log(JSON.stringify({ appExit: { code, signal }, phase, log: appLog.join("") })));
  if (app.pid) owned.add(app.pid);
  page = await electronPage(debugPort);
  await bridge(page, "updateSettings", { language: "en", onboarding: {
    consent_version: 1, accepted_at: new Date().toISOString(), completed_at: new Date().toISOString(),
  } });
  phase = "silent install reload";
  console.log(JSON.stringify({ beforeReload: await bridge(page, "getAppInfo"), appPid: app.pid, instance: readJson(join(data, "app/runtime/foreground/instance.json"))?.app_pid }));
  await page.reload();
  await proof(from);
  const session = (await bridge(page, "createSession", { kind: "chat", title: "Update retains chat" })).session;
  await stubChat(session.id);
  phase = "shell features";
  await shellFeatures(session.id);
  const oldPid = readJson(join(data, "app/runtime/foreground/instance.json"))!.app_pid;
  const oldBinary = agentPath(from);
  const oldHash = digest(oldBinary);
  phase = "Settings update";
  await settingsUpdate();
  await waitFor(() => !alive(oldPid), "old App quit");
  page.close(); page = null;
  await waitFor(() => readJson(join(data, "app/runtime/foreground/instance.json"))?.app_pid !== oldPid &&
    readJson(join(data, "app/runtime/foreground/instance.json"))?.state === "ready", "replacement foreground Agent");
  page = await electronPage(debugPort);
  await proof(to);
  assert.notEqual(digest(agentPath(to)), oldHash, "Bundled Agent was not replaced");
  assert.ok(existsSync(oldBinary), "Squirrel rollback version missing");
  assert.ok((await bridge(page, "listSessions")).sessions.some((item: any) => item.id === session.id));
  const messages = (await bridge(page, "listMessages", { chatId: session.id })).messages;
  assert.equal(messages.length, 2); assert.equal(messages[1].text, "Windows update ready.");
  ownedProcesses(data, owned);
  await page.expression("setTimeout(() => window.butlerApp.quitApp({confirmed:true}), 50); true");
  page.close(); page = null;
  await waitFor(() => [...owned].every(pid => !alive(pid)), "owned App/Agent shutdown");
  run(updater, ["--uninstall", "--silent"]);
  uninstalled = true;
  await waitFor(() => !existsSync(stub) && !existsSync(agentPath(to)), "uninstalled App removed");
  assertShortcuts(shortcuts, false);
  assert.equal(powershell("Test-Path 'HKCU:\\Software\\Classes\\butler'", env), "False");
  assert.equal(powershell("[bool](Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -ErrorAction SilentlyContinue).'com.squirrel.butler-app.Butler'", env), "False");
  assert.equal(powershell("[bool](Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run' -ErrorAction SilentlyContinue).'com.squirrel.butler-app.Butler'", env), "False");
  assert.equal(readFileSync(join(data, "sentinel.txt"), "utf8"), "retained");
  assert.ok(existsSync(join(data, "butler.config.json")));
  console.log(JSON.stringify({ ok: true, from, to, shellIntegration: true, stubCalls: calls,
    normalInstallLaunch: true, exactAgent: true, chatPreserved: true, rollbackRetained: true, uninstallPreservesData: true,
    leftoverProcesses: 0, durationMs: Date.now() - started }));
} catch (error) {
  console.error(JSON.stringify({ phase, renderer: page ? await page.diagnostics().catch(() => null) : null,
    instanceState: readJson(join(data, "app/runtime/foreground/instance.json"))?.state,
    lastExit: readJson(join(data, "app/runtime/foreground/last-exit.json")),
    packages: [from, to].map(version => ({ version,
      asarExists: existsSync(join(resolve(dirname(agentPath(version)), "../.."), "app.asar")),
      agentExists: existsSync(agentPath(version)),
    })) }));
  if (existsSync(env.ELECTRON_LOG_FILE)) console.error(readFileSync(env.ELECTRON_LOG_FILE, "utf8"));
  if (existsSync(join(data, "updates/app-install.log"))) console.error(readFileSync(join(data, "updates/app-install.log"), "utf8"));
  throw error;
} finally {
  page?.close();
  ownedProcesses(data, owned);
  for (const pid of owned) if (alive(pid)) { try { process.kill(pid, "SIGKILL"); } catch {} }
  if (!uninstalled && existsSync(updater)) run(updater, ["--uninstall", "--silent"]);
  server.stop(true);
  rmSync(root, { recursive: true, force: true });
}

async function oneClickLaunch() {
  run(join(release, `ButlerSetup-${from}-x64.exe`), []);
  await waitFor(() => Boolean(readJson(join(data, "app/runtime/foreground/instance.json"))?.app_pid), "normal Setup auto-launch");
  page = await electronPage(debugPort);
  await proof(from);
  phase = "normal install reload";
  await page.reload();
  await proof(from);
  ownedProcesses(data, owned);
  await page.expression("setTimeout(() => window.butlerApp.quitApp({confirmed:true}), 50); true");
  page.close(); page = null;
  await waitFor(() => [...owned].every(pid => !alive(pid)), "normal installation App quit");
  run(updater, ["--uninstall", "--silent"]);
  await waitFor(() => !existsSync(stub), "normal installation removed");
  console.log("PASS normal Setup installs and automatically launches the healthy App");
}

function prepare() {
  for (const folder of [env.HOME, data, env.LOCALAPPDATA, env.APPDATA]) mkdirSync(folder, { recursive: true });
  writeFileSync(join(data, "sentinel.txt"), "retained");
  writeFileSync(join(data, "butler.config.json"), JSON.stringify({ user: { name: "E2E", language: "en" },
    metrics: { enabled: false }, system: { defaultModel: "openai/gpt-6-luna" } }));
  const now = new Date().toISOString();
  mkdirSync(join(data, "personalization"), { recursive: true });
  writeFileSync(join(data, "personalization/onboarding.json"), JSON.stringify({ schema: "butler.first_chat_onboarding.v1",
    status: "complete", gateway: "any", fields: {}, skipped_fields: [], created_at: now, updated_at: now, completed_at: now }));
}

function run(command: string, args: string[]) {
  const child = spawnSync(command, args, { env, stdio: "ignore" });
  assert.equal(child.status, 0, `${command}: exit ${child.status}`);
}

function agentPath(version: string): string {
  const suffix = version.replace(/-preview\.(\d+)$/u, (_, n) => `-preview${n.padStart(10, "0")}`);
  return join(installed, `app-${suffix}/resources/bundled-agent/bin/butler-agent.exe`);
}

function digest(path: string): string { return createHash("sha256").update(readFileSync(path)).digest("hex"); }

async function proof(version: string) {
  ownedProcesses(data, owned);
  assert.equal((await bridge(page!, "getAppInfo")).version, version);
  assert.equal((await bridge(page!, "health")).ok, true);
  const agent = spawnSync(agentPath(version), ["--version"], { env, encoding: "utf8" });
  assert.equal(agent.status, 0); assert.ok(agent.stdout.includes(version));
  assert.equal(readFileSync(join(data, "sentinel.txt"), "utf8"), "retained");
  assert.equal(readJson(join(data, "app/runtime/foreground/startup-progress.json"))?.tray_ready, true);
}

async function stubChat(chatId: string) {
  await bridge(page!, "updateSettings", { model: "openai/gpt-6-luna", reasoning_effort: "low", access_mode: "ask_first" });
  await bridge(page!, "sendMessage", { chatId, text: "Reply with Windows update ready.", clientMessageId: crypto.randomUUID() });
  await waitFor(async () => (await bridge(page!, "listTurns", { chatId })).turns.some((turn: any) => turn.state === "delivered"), "stub chat");
  const messages = (await bridge(page!, "listMessages", { chatId })).messages;
  assert.equal(messages.length, 2); assert.equal(messages[0].role, "user");
  assert.equal(messages[1].text, "Windows update ready."); assert.equal(calls, 1);
}

function shellProof() {
  const command = powershell("(Get-Item 'HKCU:\\Software\\Classes\\butler\\shell\\open\\command').GetValue('')", env);
  assert.ok(command.includes(stub), "Protocol does not target the version-independent stub");
  for (const path of shortcuts) {
    const facts = JSON.parse(powershell(`$shell = New-Object -ComObject Shell.Application
      $folder = $shell.NameSpace([IO.Path]::GetDirectoryName($env:BUTLER_SHORTCUT))
      $item = $folder.ParseName([IO.Path]::GetFileName($env:BUTLER_SHORTCUT))
      @{ aumid = $item.ExtendedProperty('System.AppUserModel.ID'); target = (New-Object -ComObject WScript.Shell).CreateShortcut($env:BUTLER_SHORTCUT).TargetPath } | ConvertTo-Json -Compress`, { ...env, BUTLER_SHORTCUT: path }));
    assert.equal(facts.aumid, "com.squirrel.butler-app.Butler"); assert.equal(facts.target, stub);
  }
}

async function shellFeatures(sessionId: string) {
  phase = "login toggle";
  for (const enabled of [true, false, true]) {
    assert.equal((await bridge(page!, "setLoginSettings", { openAtLogin: enabled })).openAtLogin, enabled);
    const value = powershell("[string](Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -ErrorAction SilentlyContinue).'com.squirrel.butler-app.Butler'", env);
    assert.equal(value.includes(stub), enabled);
  }
  phase = "close to tray";
  const closeButton = "document.querySelector('[data-test-class=\"app-window-close\"]')";
  await waitFor(async () => await page!.expression(`Boolean(${closeButton})`), "native close button");
  await page!.expression(`${closeButton}.click(); true`);
  await waitFor(async () => await page!.expression("document.visibilityState === 'hidden'"), "close to tray");
  assert.equal((await bridge(page!, "health")).ok, true);
  phase = "native notification";
  const notification = await bridge(page!, "testDesktopNotification");
  assert.equal(notification.shown, true); assert.equal(notification.status.last_error, null);
  assert.ok(notification.status.last_shown_at, "Native notification show event missing");
  phase = "deep link";
  await page!.expression("window.__navigation = null; window.butlerApp.onNativeNavigation(value => window.__navigation = value); true");
  powershell("Start-Process $env:BUTLER_DEEP_LINK", { ...env, BUTLER_DEEP_LINK: `butler://session/${sessionId}` });
  await waitFor(async () => await page!.expression(`window.__navigation?.sessionId === ${JSON.stringify(sessionId)}`), "registered deep link dispatch");
  await waitFor(async () => await page!.expression("document.visibilityState === 'visible'"), "deep link restores window");
}

async function settingsUpdate() {
  await click(page!, "Settings"); await click(page!, "Updates");
  const row = "document.querySelector('[data-test-id=\"update-component-app\"] button')";
  await waitFor(async () => await page!.expression(`Boolean(${row}) && ${row}.disabled`), "preview hidden");
  assert.equal(await page!.expression("document.querySelector('[data-setting-id=\"update-previews\"] [role=\"switch\"]').getAttribute('aria-checked')"), "false");
  await page!.expression("document.querySelector('[data-setting-id=\"update-previews\"] [role=\"switch\"]').click()");
  await waitFor(async () => await page!.expression(`${row} && !${row}.disabled`), "Update enabled");
  assert.ok((await page!.expression<string>("document.querySelector('[data-test-id=\"update-component-app\"]').innerText")).includes(to));
  await page!.expression(`(${row}).click(); true`);
}
