import { launchInstalledApp, relaunchInstalledAppForDebugging } from "./installed-app-debug.ts";
/** Disposable-runner E2E: real Setup, Settings update, shell integration, uninstall. */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { electronProfilePage, type ElectronPage } from "../../../../tests/support/electron-page-cdp.ts";
import { FIRST_RUN_CONSENT_VERSION } from "../../client/ui/src/app/onboarding.ts";
import { freePort } from "../../../../tests/support/native-app-server.ts";
import { alive, assertShortcuts, bridge, click, ownedProcesses, ownedSurvivors, powershell, preserveInstallerLogs, readJson, removeProfile, shortcutPaths, versionProcesses, waitFor, waitForOwnedExit, type OwnedProcesses } from "./installer-smoke-support.ts";
import { smokeProviderReply } from "./smoke-provider.ts";
import { proveReleasedDownloads, releasedDownloadsReply, type DownloadsProof } from "./released-downloads-smoke.ts";
import { processRoleFileNames } from "../../client/electron/scripts/process-role-names.mjs";
import { windowsPowerShellEnvironment } from "../../client/electron/windows-powershell-environment.mjs";

if (process.platform !== "win32" || process.env.GITHUB_ACTIONS !== "true" || process.env.RUNNER_ENVIRONMENT !== "github-hosted") {
  throw new Error("Registry/shortcut/installer smoke is restricted to disposable GitHub-hosted runners");
}
const release = resolve(process.argv[2]);
const second = resolve(process.argv[3]);
const from = process.env.BUTLER_WINDOWS_SMOKE_FROM ?? "0.1.0-preview.90";
const to = process.env.BUTLER_WINDOWS_SMOKE_TO ?? "0.1.0-preview.91";
assert.match(from, /^0\.1\.0-preview\.\d+$/u);
assert.match(to, /^0\.1\.0-preview\.\d+$/u);
const root = realpathSync.native(mkdtempSync(join(tmpdir(), "butler-installer-e2e-")));
const data = join(root, "data");
const owned: OwnedProcesses = new Map();
let page: ElectronPage | null = null;
let devToolsEndpoint: string | null = null;
const calls = { chat: 0, memory: 0, memorySpeakers: new Set<string>() };
const downloads: DownloadsProof = { requests: 0 };
const downloadsCalls = { chat: 0, memory: 0, memorySpeakers: new Set<string>() };
let uninstalled = false;
let failed = false;
let phase = "one-click install";
const manifest = readJson(join(second, "app-update-manifest.json"))!;
const artifact = manifest.artifacts.find((item: any) => item.platform === "windows-x64");
assert.equal(artifact?.version, to, "Candidate manifest must describe the exact update version");
const packageName = artifact.artifact_url.split("/").at(-1);
const packagePath = join(second, packageName);
const packageBytes = readFileSync(packagePath);
const packageEntries: string[] = JSON.parse(powershell(`Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [IO.Compression.ZipFile]::OpenRead($env:BUTLER_SMOKE_PACKAGE)
  try { ConvertTo-Json -Compress -InputObject @($zip.Entries | ForEach-Object { $_.FullName }) }
  finally { $zip.Dispose() }`, { ...process.env, BUTLER_SMOKE_PACKAGE: packagePath }));
const binPrefix = "lib/net45/resources/bundled-agent/bin/";
assert.deepEqual(packageEntries.filter(name => name.startsWith(binPrefix) && name !== binPrefix)
  .map(name => name.slice(binPrefix.length)).sort(), ["butler-agent.exe", "butler-sandbox.exe"],
"Candidate nupkg must contain only the canonical Agent and sandbox helper in bin");
assert.equal(createHash("sha256").update(packageBytes).digest("hex"), artifact.sha256);
const feed = readFileSync(join(second, "RELEASES"), "utf8").trim().split(/\s+/u);
assert.equal(feed.length, 3, "Expected one complete RELEASES entry");
assert.equal(feed[0].toLowerCase(), createHash("sha1").update(packageBytes).digest("hex"));
assert.equal(feed[1], packageName);
assert.equal(Number(feed[2]), packageBytes.length);
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
  const path = new URL(request.url).pathname;
  if (path === "/v1/responses") {
    const body = await request.json();
    const listing = releasedDownloadsReply(body, downloads, downloadsCalls);
    if (listing) return listing;
    return smokeProviderReply(body, "Reply with Windows update ready.", "Windows update ready.", calls, input => {
      assert.ok(["user", "assistant"].includes(input.speaker), "Unexpected memory speaker");
      assert.ok(!calls.memorySpeakers.has(input.speaker), "Repeated extraction of the same chat speaker");
      const expected = input.speaker === "user" ? "Reply with Windows update ready." : "Windows update ready.";
      assert.equal(input.parts.map((part: any) => part.text).join(""), expected);
      console.log(JSON.stringify({ meaningSpeaker: input.speaker, phase, parts: input.parts.length }));
    });
  }
  if (path === `/${packageName}`) return new Response(Bun.file(join(second, packageName)));
  if (path === "/manifest.json") return Response.json({ ...manifest, artifacts: manifest.artifacts.map((item: any) => ({
    ...item, artifact_url: `http://127.0.0.1:${server.port}/${packageName}`,
  })) });
  return new Response(null, { status: 404 });
} });
const agentPort = await freePort();
const env = { ...windowsPowerShellEnvironment(), HOME: join(root, "home"), USERPROFILE: join(root, "home"), BUTLER_DATA: data,
  LOCALAPPDATA: join(root, "home/AppData/Local"), APPDATA: join(root, "home/AppData/Roaming"), BUTLER_SECRET_STORE: "file",
  SQUIRREL_TEMP: join(root, "home/AppData/Local"), TEMP: join(root, "tmp"), TMP: join(root, "tmp"),
  BUTLER_APP_ELECTRON_USER_DATA_DIR: join(root, "profile"),
  BUTLER_APP_SERVER_PORT: String(agentPort), BUTLER_E2E_TIER: "stub", BUTLER_PROVIDER_QUOTA_POLLING: "0",
  OPENAI_API_KEY: "e2e-not-real", OPENAI_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
  ELECTRON_ENABLE_LOGGING: "1", ELECTRON_LOG_FILE: join(root, "electron.log"),
  BUTLER_APP_UPDATE_MANIFEST: process.env.BUTLER_WINDOWS_SMOKE_MANIFEST ?? `http://127.0.0.1:${server.port}/manifest.json`,
  BUTLER_APP_ALLOW_PRECONFIRMED_E2E_QUIT: "1",
};
const installed = join(powershell("[Environment]::GetFolderPath('LocalApplicationData', [Environment+SpecialFolderOption]::DoNotVerify)", env), "butler-app");
assert.equal(resolve(dirname(installed)).toLowerCase(), resolve(env.LOCALAPPDATA).toLowerCase(), "Squirrel and App local profile must agree");
const stub = join(installed, "Butler.exe");
const updater = join(installed, "Update.exe");
const shortcuts = [join(env.APPDATA, "Microsoft/Windows/Start Menu/Programs/Butler.lnk"), shortcutPaths(env)[1]!];
const started = Date.now();
try {
  prepare();
  await oneClickLaunch();
  phase = "silent install";
  const silentStarted = Date.now();
  run(join(release, `ButlerSetup-${from}-x64.exe`), ["--silent"]);
  console.log(JSON.stringify({ phase, setupDurationMs: Date.now() - silentStarted }));
  await waitFor(() => existsSync(stub) && existsSync(updater), "per-user install");
  await waitFor(() => shortcuts.every(path => existsSync(path)), "Start Menu and Desktop shortcuts");
  assertShortcuts(shortcuts, true);
  shellProof();
  // Silent Squirrel installation does not necessarily start the first-run app.
  const app = launchInstalledApp(stub, 0, env, owned);
  page = await appPage();
  await bridge(page, "updateSettings", { language: "en", onboarding: {
    consent_version: FIRST_RUN_CONSENT_VERSION, accepted_at: new Date().toISOString(), completed_at: new Date().toISOString(),
  } });
  phase = "silent install reload";
  console.log(JSON.stringify({ beforeReload: await bridge(page, "getAppInfo"), appPid: app.pid, instance: readJson(join(data, "app/runtime/foreground/instance.json"))?.app_pid }));
  await page.reload();
  await proof(from);
  const session = (await bridge(page, "createSession", { kind: "chat", title: "Update retains chat" })).session;
  await stubChat(session.id);
  phase = "shell features";
  await shellFeatures(session.id);
  ownedProcesses(data, owned);
  const oldPid = readJson(join(data, "app/runtime/foreground/instance.json"))!.app_pid;
  const oldBinary = agentPath(from);
  const oldHash = digest(oldBinary);
  assert.ok(owned.has(oldPid), "Running App is not an owned process");
  const oldApp: OwnedProcesses = new Map([[oldPid, owned.get(oldPid)!]]);
  phase = "Settings update";
  await settingsUpdate();
  await waitForOwnedExit(oldApp, "old App quit");
  page.close(); page = null;
  await waitFor(() => readJson(join(data, "app/runtime/foreground/instance.json"))?.app_pid !== oldPid &&
    readJson(join(data, "app/runtime/foreground/instance.json"))?.state === "ready", "replacement foreground Agent");
  await assertOnlyUpdatedApp();
  page = await appPage();
  await proof(to);
  assert.notEqual(digest(agentPath(to)), oldHash, "Bundled Agent was not replaced");
  assert.ok(existsSync(oldBinary), "Squirrel rollback version missing");
  assert.ok((await bridge(page, "listSessions")).sessions.some((item: any) => item.id === session.id));
  const messages = (await bridge(page, "listMessages", { chatId: session.id })).messages;
  assert.equal(messages.length, 2); assert.equal(messages[1].text, "Windows update ready.");
  phase = "candidate Downloads command";
  await proveReleasedDownloads(page, env.HOME, downloads);
  ownedProcesses(data, owned);
  await page.expression("setTimeout(() => window.butlerApp.quitApp({confirmed:true}), 50); true");
  page.close(); page = null;
  await waitForOwnedExit(owned, "owned App/Agent shutdown");
  run(updater, ["--uninstall", "--silent"]);
  uninstalled = true;
  await waitFor(() => !existsSync(stub) && !existsSync(agentPath(to)), "uninstalled App removed");
  assertShortcuts(shortcuts, false);
  assert.equal(powershell("Test-Path 'HKCU:\\Software\\Classes\\butler'", env), "False");
  assert.equal(powershell("[bool](Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -ErrorAction SilentlyContinue).'com.squirrel.butler-app.Butler'", env), "False");
  assert.equal(powershell("[bool](Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run' -ErrorAction SilentlyContinue).'com.squirrel.butler-app.Butler'", env), "False");
  assert.equal(readFileSync(join(data, "sentinel.txt"), "utf8"), "retained");
  assert.ok(existsSync(join(data, "butler.config.json")));
  assert.equal(calls.chat, 1); assert.equal(calls.memory, 2);
  assert.deepEqual([...calls.memorySpeakers].sort(), ["assistant", "user"]);
  console.log(JSON.stringify({ ok: true, from, to, shellIntegration: true, stubCalls: calls.chat + calls.memory,
    chatCalls: calls.chat, memoryCalls: calls.memory,
    normalInstallLaunch: true, windowCloseQuit: true, exactAgent: true, chatPreserved: true, rollbackRetained: true, uninstallPreservesData: true,
    leftoverProcesses: 0, durationMs: Date.now() - started }));
} catch (error) {
  failed = true;
  preserveInstallerLogs(root, installed, env, phase);
  console.error(JSON.stringify({ phase, renderer: page ? await page.diagnostics().catch(() => null) : null,
    providerCalls: { chat: calls.chat, memory: calls.memory, speakers: [...calls.memorySpeakers].sort() },
    memoryState: memoryState(),
    shortcutState: shortcuts.map(path => ({ path, exists: existsSync(path) })),
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
  await cleanupInstaller();
}

async function cleanupInstaller() {
  const errors: unknown[] = [];
  try {
    page?.close();
    const capture = readJson(resolve("dist/startup-installer-evidence/install/capture-process.json"));
    if (Number.isInteger(capture?.setup_pid) && alive(capture!.setup_pid)) {
      const started = powershell(`$process = Get-Process -Id $env:BUTLER_INSTALLER_SETUP_PID -ErrorAction SilentlyContinue
        if ($process) { $process.StartTime.ToUniversalTime().ToString('o') }`,
      { ...env, BUTLER_INSTALLER_SETUP_PID: String(capture!.setup_pid) });
      if (started === capture!.started_at) {
        const created = Date.parse(started);
        owned.set(capture!.setup_pid, { created, notAfter: created });
      }
    }
    ownedProcesses(data, owned);
    for (const { pid } of ownedSurvivors(owned)) { try { process.kill(pid, "SIGKILL"); } catch {} }
    await waitForOwnedExit(owned, "failed installer owned process cleanup");
    if (!uninstalled && existsSync(updater)) run(updater, ["--uninstall", "--silent"]);
  } catch (error) { errors.push(error); }
  for (const action of [
    () => preserveInstallerLogs(root, installed, env, phase, "cleanup"),
    () => server.stop(true), () => removeProfile(root, env),
  ]) {
    try { action(); } catch (error) { errors.push(error); }
  }
  for (const error of errors) console.error(`Installer cleanup failed: ${String(error)}`);
  if (errors.length && !failed) throw errors[0];
}

function memoryState() {
  try { return readMemoryState(); }
  catch (error) { return { diagnosticError: error instanceof Error ? error.name : "unavailable" }; }
}

function readMemoryState() {
  const memory = join(data, "cognition/memory");
  const queue = join(memory, "queue/sync.jsonl");
  return {
    active: readJson(join(memory, "active-generation.json")),
    files: existsSync(memory) ? readdirSync(memory, { recursive: true }).map(String).sort() : [],
    queuedSources: existsSync(queue) ? readFileSync(queue, "utf8").split("\n").filter(Boolean).map(line => {
      const entry = JSON.parse(line);
      return { schema: entry.schema_version, kind: entry.source?.kind, jobId: entry.job_id };
    }) : [],
    schedules: ["session-sync", "consolidation-cycle"].map(id => {
      const state = readJson(join(data, `state/scheduler/${id}.json`));
      return { id, status: state?.status, lastRunDate: state?.lastRunDate, lastRunAt: state?.lastRunAt };
    }),
  };
}

async function oneClickLaunch() {
  const installer = join(release, `ButlerSetup-${from}-x64.exe`);
  assert.equal(digest(installer), readFileSync(installer + ".sha256", "utf8").trim().split(/\s+/u)[0], "Baseline installer checksum");
  run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
    resolve("packages/butler-agent/rust/crates/butler-platform/scripts/capture-installer.ps1"),
    "-Setup", join(release, `ButlerSetup-${from}-x64.exe`),
    "-Output", resolve("dist/startup-installer-evidence/install")]);
  const setup = readJson(resolve("dist/startup-installer-evidence/install/capture-process.json"));
  console.log(JSON.stringify({ phase, setupDurationMs: setup?.duration_ms, setupExitCode: setup?.exit_code }));
  await waitFor(() => Boolean(readJson(join(data, "app/runtime/foreground/instance.json"))?.app_pid), "normal Setup auto-launch");
  await relaunchInstalledAppForDebugging(stub, 0, env, owned);
  page = await appPage();
  await proof(from);
  phase = "normal install reload";
  await page.reload();
  await proof(from);
  ownedProcesses(data, owned);
  await page.expression("setTimeout(() => window.butlerApp.quitApp({confirmed:true}), 50); true");
  page.close(); page = null;
  await waitForOwnedExit(owned, "normal installation App quit");
  run(updater, ["--uninstall", "--silent"]);
  await waitFor(() => !existsSync(stub), "normal installation removed");
  console.log("PASS normal Setup installs and automatically launches the healthy App");
}

function prepare() {
  for (const folder of [env.HOME, data, env.LOCALAPPDATA, env.APPDATA, env.TEMP, dirname(shortcuts[1]!)]) mkdirSync(folder, { recursive: true });
  writeFileSync(join(data, "sentinel.txt"), "retained");
  // Preview builds default to preview updates; this smoke exercises an explicit OFF -> ON choice.
  writeFileSync(join(data, "butler.config.json"), JSON.stringify({ update: { previews: false }, user: { name: "E2E", language: "en" },
    metrics: { enabled: false }, system: { defaultModel: "openai/gpt-6-luna" } }));
  const now = new Date().toISOString();
  mkdirSync(join(data, "personalization"), { recursive: true });
  writeFileSync(join(data, "personalization/onboarding.json"), JSON.stringify({ schema: "butler.first_chat_onboarding.v1",
    status: "complete", gateway: "any", fields: {}, skipped_fields: [], created_at: now, updated_at: now, completed_at: now }));
}

function run(command: string, args: string[]) {
  if (command === join(release, `ButlerSetup-${from}-x64.exe`)) {
    const expected = readFileSync(command + ".sha256", "utf8").trim().split(/\s+/u)[0];
    assert.equal(digest(command), expected, "Baseline installer checksum");
  }
  const child = spawnSync(command, args, { env, encoding: "utf8" });
  if (child.status !== 0) {
    console.error(JSON.stringify({ phase, command, args, status: child.status,
      error: child.error?.message, stdout: child.stdout, stderr: child.stderr }));
  }
  assert.equal(child.status, 0, `${command}: exit ${child.status}`);
}

function versionFolder(version: string): string {
  const suffix = version.replace(/-preview\.(\d+)$/u, (_, n) => `-preview${n.padStart(10, "0")}`);
  return join(installed, `app-${suffix}`);
}

function agentPath(version: string): string {
  return join(versionFolder(version), "resources/bundled-agent/bin/butler-agent.exe");
}

function assertRoleLinks(version: string) {
  const binary = agentPath(version);
  const source = statSync(binary, { bigint: true });
  for (const name of processRoleFileNames("win32")) {
    const alias = join(dirname(binary), name);
    assert.equal(lstatSync(alias).isSymbolicLink(), false, `${name} must not be a reparse point`);
    const metadata = statSync(alias, { bigint: true });
    assert.equal(metadata.ino, source.ino, `${name} must share the canonical file identity`);
    assert.equal(metadata.dev, source.dev, `${name} must share the canonical device`);
  }
}

async function appPage(): Promise<ElectronPage> {
  const found = await electronProfilePage(env.BUTLER_APP_ELECTRON_USER_DATA_DIR, devToolsEndpoint);
  devToolsEndpoint = found.endpoint;
  return found.page;
}

/** After activation nothing from the replaced version survives, and exactly one updated App runs. */
async function assertOnlyUpdatedApp() {
  await waitFor(() => versionProcesses(versionFolder(from), env).length === 0, "replaced App version processes exit");
  const apps = versionProcesses(versionFolder(to), env).filter(item => item.app);
  const ready = readJson(join(data, "app/runtime/foreground/instance.json"))!.app_pid;
  assert.deepEqual(apps.map(item => item.pid), [ready], "Exactly one updated App instance");
  console.log(JSON.stringify({ phase, replacedVersionProcesses: 0, updatedAppInstances: apps.length }));
}

function digest(path: string): string { return createHash("sha256").update(readFileSync(path)).digest("hex"); }

async function proof(version: string) {
  ownedProcesses(data, owned);
  assert.equal((await bridge(page!, "getAppInfo")).version, version);
  assert.equal((await bridge(page!, "health")).ok, true);
  assertRoleLinks(version);
  const agent = spawnSync(agentPath(version), ["--version"], { env, encoding: "utf8" });
  assert.equal(agent.status, 0); assert.ok(agent.stdout.includes(version));
  assert.equal(readFileSync(join(data, "sentinel.txt"), "utf8"), "retained");
  await waitFor(() => readJson(join(data, "app/runtime/foreground/startup-progress.json"))?.stage === "window_ready", "window ready before tray proof");
  assert.equal(readJson(join(data, "app/runtime/foreground/startup-progress.json"))?.tray_ready, true);
}

async function stubChat(chatId: string) {
  await bridge(page!, "updateSettings", { model: "openai/gpt-6-luna", reasoning_effort: "low", access_mode: "ask_first" });
  await bridge(page!, "sendMessage", { chatId, text: "Reply with Windows update ready.", clientMessageId: crypto.randomUUID() });
  await waitFor(async () => (await bridge(page!, "listTurns", { chatId })).turns.some((turn: any) => turn.state === "delivered"), "stub chat");
  const messages = (await bridge(page!, "listMessages", { chatId })).messages;
  assert.equal(messages.length, 2); assert.equal(messages[0].role, "user");
  assert.equal(messages[1].text, "Windows update ready."); assert.equal(calls.chat, 1);
  await waitFor(() => calls.memory === 2, "both user and assistant meaning extractions");
  assert.deepEqual([...calls.memorySpeakers].sort(), ["assistant", "user"]);
}

function shellProof() {
  const command = powershell("(Get-Item 'HKCU:\\Software\\Classes\\butler\\shell\\open\\command').GetValue('')", env);
  assert.ok(command.includes(stub), `Protocol does not target the version-independent stub: ${JSON.stringify({ command, stub })}`);
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
  await windowCloseAndRelaunch(sessionId);
  phase = "native notification";
  const notification = await bridge(page!, "testDesktopNotification");
  assert.equal(notification.shown, true); assert.equal(notification.status.last_error, null);
  assert.ok(notification.status.last_shown_at, "Native notification show event missing");
  phase = "deep link";
  await page!.expression("window.__navigation = null; window.butlerApp.onNativeNavigation(value => window.__navigation = value); true");
  await page!.expression("document.querySelector('[data-test-class=\"app-window-minimize\"]').click(); true");
  await waitFor(async () => await page!.expression("document.visibilityState === 'hidden'"), "minimized window");
  powershell("Start-Process $env:BUTLER_DEEP_LINK", { ...env, BUTLER_DEEP_LINK: `butler://session/${sessionId}` });
  await waitFor(async () => await page!.expression(`window.__navigation?.sessionId === ${JSON.stringify(sessionId)}`), "registered deep link dispatch");
  await waitFor(async () => await page!.expression("document.visibilityState === 'visible'"), "deep link restores window");
}

async function windowCloseAndRelaunch(sessionId: string) {
  phase = "window close and relaunch";
  const previous = readJson(join(data, "app/runtime/foreground/instance.json"))!;
  ownedProcesses(data, owned);
  const closeButton = "document.querySelector('[data-test-class=\"app-window-close\"]')";
  await waitFor(async () => await page!.expression(`Boolean(${closeButton})`), "native close button");
  // Windows X uses the normal Quit path, including foreground Agent shutdown.
  await page!.expression(`setTimeout(() => ${closeButton}.click(), 50); true`);
  page!.close(); page = null;
  await waitForOwnedExit(owned, "window close shuts down App and Agent");
  const stopped = readJson(join(data, "app/runtime/foreground/instance.json"))!;
  assert.equal(stopped.state, "stopped"); assert.equal(stopped.clean_exit, true);
  const exit = readJson(join(data, "app/runtime/foreground/last-exit.json"))!;
  assert.equal(exit.generation, previous.generation); assert.equal(exit.exit_reason, "app_quit");
  assert.equal(exit.graceful, true); assert.equal(exit.process_tree_dead, true); assert.equal(exit.port_released, true);
  launchInstalledApp(stub, 0, env, owned);
  await waitFor(() => {
    const instance = readJson(join(data, "app/runtime/foreground/instance.json"));
    return instance?.state === "ready" && instance.app_pid !== previous.app_pid;
  }, "replacement foreground Agent after window close");
  page = await appPage();
  await proof(from);
  const messages = (await bridge(page, "listMessages", { chatId: sessionId })).messages;
  assert.equal(messages.length, 2); assert.equal(messages[0].text, "Reply with Windows update ready.");
  assert.equal(messages[1].text, "Windows update ready.");
  assert.equal(calls.chat, 1); assert.equal(calls.memory, 2);
}

async function settingsUpdate() {
  await click(page!, "Settings"); await click(page!, "Updates");
  const row = "document.querySelector('[data-test-id=\"update-component-app\"] button')";
  const component = "document.querySelector('[data-test-id=\"update-component-app\"]')";
  await waitFor(async () => await page!.expression(`Boolean(${row}) && ${row}.disabled && !${component}.innerText.includes(${JSON.stringify(to)})`), "preview hidden");
  assert.equal(await page!.expression("document.querySelector('[data-setting-id=\"update-previews\"] [role=\"switch\"]').getAttribute('aria-checked')"), "false");
  await page!.expression("document.querySelector('[data-setting-id=\"update-previews\"] [role=\"switch\"]').click()");
  await waitFor(async () => await page!.expression(`${row} && !${row}.disabled`), "Update enabled");
  assert.ok((await page!.expression<string>(`${component}.innerText`)).includes(to));
  await page!.expression(`(${row}).click(); true`);
}
