/** Install the actual published preview, launch, use a stub chat, and uninstall. */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { electronPage, type ElectronPage } from "../../../../tests/support/electron-page-cdp.ts";
import { freePort } from "../../../../tests/support/native-app-server.ts";
import { FIRST_RUN_CONSENT_VERSION } from "../../client/ui/src/app/onboarding.ts";
import { alive, assertShortcuts, bridge, ownedProcesses, powershell, readJson, shortcutPaths, waitFor } from "./installer-smoke-support.ts";
import { smokeProviderReply, type SmokeProviderCalls } from "./smoke-provider.ts";
import { windowsPowerShellEnvironment } from "../../client/electron/windows-powershell-environment.mjs";
import { proveReleasedDownloads, releasedDownloadsReply, type DownloadsProof } from "./released-downloads-smoke.ts";

if (process.platform !== "win32" || process.env.GITHUB_ACTIONS !== "true" || process.env.RUNNER_ENVIRONMENT !== "github-hosted") {
  throw new Error("Released installer smoke requires a disposable GitHub-hosted Windows runner");
}
const release = resolve(process.argv[2]);
const version = process.argv[3]?.replace(/^v/u, "");
assert.ok(version && /^0\.1\.0-preview\.\d+$/u.test(version), "A preview release version is required");
const installer = join(release, `ButlerSetup-${version}-x64.exe`);
const expected = readFileSync(installer + ".sha256", "utf8").trim().split(/\s+/u)[0];
assert.equal(createHash("sha256").update(readFileSync(installer)).digest("hex"), expected);
const root = realpathSync.native(mkdtempSync(join(tmpdir(), "butler-released-e2e-")));
const data = join(root, "data");
const owned = new Set<number>();
const debugPort = await freePort();
const agentPort = await freePort();
let page: ElectronPage | null = null;
const calls: SmokeProviderCalls = { chat: 0, memory: 0, memorySpeakers: new Set<string>() };
const downloads: DownloadsProof = { requests: 0 };
let uninstalled = false;
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
  assert.equal(new URL(request.url).pathname, "/v1/responses");
  const body = await request.json();
  return releasedDownloadsReply(body, downloads, calls) ??
    smokeProviderReply(body, "Reply with Windows release ready.", "Windows release ready.", calls);
} });
const env = { ...windowsPowerShellEnvironment(), HOME: join(root, "home"), USERPROFILE: join(root, "home"), BUTLER_DATA: data,
  LOCALAPPDATA: join(root, "local"), APPDATA: join(root, "roaming"), BUTLER_SECRET_STORE: "file",
  BUTLER_APP_ELECTRON_USER_DATA_DIR: join(root, "profile"), BUTLER_APP_SMOKE_DEBUG_PORT: String(debugPort),
  BUTLER_APP_SERVER_PORT: String(agentPort), BUTLER_E2E_TIER: "stub", BUTLER_PROVIDER_QUOTA_POLLING: "0",
  BUTLER_E2E_APP_NOW: "2026-10-03T20:00:00.000Z",
  OPENAI_API_KEY: "e2e-not-real", OPENAI_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
  BUTLER_APP_ALLOW_PRECONFIRMED_E2E_QUIT: "1",
};
const installed = join(powershell("[Environment]::GetFolderPath('LocalApplicationData')", env), "butler-app");
const updater = join(installed, "Update.exe");
const shortcuts = [join(env.APPDATA, "Microsoft/Windows/Start Menu/Programs/Butler.lnk"), shortcutPaths(env)[1]!];
const started = Date.now();
try {
  assert.ok(!existsSync(installed), "Disposable runner already has a Butler installation");
  assert.equal(powershell("Test-Path 'HKCU:\\Software\\Classes\\butler'", env), "False");
  for (const folder of [env.HOME, data, env.LOCALAPPDATA, env.APPDATA, dirname(shortcuts[1]!)]) mkdirSync(folder, { recursive: true });
  writeFileSync(join(data, "sentinel.txt"), "released data retained\n");
  writeFileSync(join(data, "butler.config.json"), JSON.stringify({ user: { name: "E2E", language: "en" },
    metrics: { enabled: false }, system: { defaultModel: "openai/gpt-6-luna" } }));
  const now = new Date().toISOString();
  mkdirSync(join(data, "personalization"), { recursive: true });
  writeFileSync(join(data, "personalization/onboarding.json"), JSON.stringify({ schema: "butler.first_chat_onboarding.v1",
    status: "complete", gateway: "any", fields: {}, skipped_fields: [], created_at: now, updated_at: now, completed_at: now }));
  run(installer, []);
  await waitFor(() => existsSync(updater), "released one-click install");
  page = await electronPage(debugPort);
  assert.equal((await bridge(page, "getAppInfo")).version, version);
  assert.equal((await bridge(page, "health")).ok, true);
  await bridge(page, "updateSettings", { language: "en", onboarding: {
    consent_version: FIRST_RUN_CONSENT_VERSION, accepted_at: now, completed_at: now,
  }, model: "openai/gpt-6-luna", reasoning_effort: "low", access_mode: "ask_first" });
  const session = (await bridge(page, "createSession", { kind: "chat", title: "Published release" })).session;
  await bridge(page, "sendMessage", { chatId: session.id, text: "Reply with Windows release ready.", clientMessageId: crypto.randomUUID() });
  await waitFor(async () => (await bridge(page!, "listTurns", { chatId: session.id })).turns.some((turn: any) => turn.state === "delivered"), "released stub chat");
  const messages = (await bridge(page, "listMessages", { chatId: session.id })).messages;
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, "user");
  assert.equal(messages[1].text, "Windows release ready.");
  assert.equal(calls.chat, 1);
  await waitFor(() => calls.memory === 2, "released user and assistant meaning extractions");
  assert.deepEqual([...calls.memorySpeakers].sort(), ["assistant", "user"]);
  await briefingProof();
  await proveReleasedDownloads(page, env.HOME, downloads);
  await waitFor(() => shortcuts.every(path => existsSync(path)), "released shortcuts");
  assertShortcuts(shortcuts, true);
  const stub = join(installed, "Butler.exe");
  assert.ok(powershell("(Get-Item 'HKCU:\\Software\\Classes\\butler\\shell\\open\\command').GetValue('')", env).includes(stub));
  ownedProcesses(data, owned);
  await page.expression("setTimeout(() => window.butlerApp.quitApp({confirmed:true}), 50); true");
  page.close(); page = null;
  await waitFor(() => [...owned].every(pid => !alive(pid)), "released App and Agent quit");
  run(updater, ["--uninstall", "--silent"]);
  uninstalled = true;
  await waitFor(() => !existsSync(stub), "released uninstall");
  assertShortcuts(shortcuts, false);
  assert.equal(powershell("Test-Path 'HKCU:\\Software\\Classes\\butler'", env), "False");
  assert.equal(readFileSync(join(data, "sentinel.txt"), "utf8"), "released data retained\n");
  await briefingProof();
  console.log(JSON.stringify({ ok: true, version, sha256: expected, normalInstallLaunch: true,
    chatCalls: calls.chat, memoryCalls: calls.memory, briefingCalls: calls.briefings!.size,
    briefingSuggestions: 4, shellIntegration: true, uninstallPreservesData: true, leftoverProcesses: 0,
    durationMs: Date.now() - started }));
} finally {
  page?.close();
  ownedProcesses(data, owned);
  for (const pid of owned) if (alive(pid)) { try { process.kill(pid, "SIGKILL"); } catch {} }
  if (!uninstalled && existsSync(updater)) run(updater, ["--uninstall", "--silent"]);
  server.stop(true);
  rmSync(root, { recursive: true, force: true });
}

function run(command: string, args: string[]) {
  const child = spawnSync(command, args, { env, stdio: "ignore" });
  assert.equal(child.status, 0, `${command}: exit ${child.status}`);
}

async function briefingProof() {
  await waitFor(() => calls.briefings?.size === 1, "released scheduled briefing request");
  const expected = [...calls.briefings!.values()][0]!;
  const path = join(data, "cognition/consolidation/briefings", expected.generatedAt.slice(0, 10), "general.json");
  await waitFor(() => readJson(path)?.source?.consolidation_run_id === expected.runId, "released durable briefing");
  const actual = readJson(path)!;
  assert.equal(actual.schema, "butler.cognition.new-chat-briefing.v1");
  assert.equal(actual.scope, "general");
  assert.equal(actual.locale, "en");
  for (const field of ["moment", "title", "description", "suggestions", "title_variants"] as const) {
    assert.deepEqual(actual[field], expected.reply[field]);
  }
  assert.equal(actual.source.generated_at, expected.generatedAt);
  assert.equal(actual.source.model_ref, "openai/gpt-6-luna");
  assert.equal(actual.source.persona_applied, true);
  assert.equal(actual.raw_text_included, false);
}
