// UI smoke: the packaged App's permission menu, its agent controls and next-tool authority.
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { chromium, type Page } from "playwright";
import { launchInstalledApp } from "../../packages/butler-app/scripts/windows/installed-app-debug.ts";
import { ownedProcesses, ownedSurvivors, waitForOwnedExit, type OwnedProcesses } from "../../packages/butler-app/scripts/windows/installer-smoke-support.ts";
import { windowsPowerShellEnvironment } from "../../packages/butler-app/client/electron/windows-powershell-environment.mjs";

const executable = resolve(process.argv[2]!);
const data = process.env.BUTLER_DATA!;
const home = process.env.HOME!;
assert(data && home && process.env.BUTLER_APP_DISABLE_SHELL_REGISTRATION === "1", "isolated launcher required");
assert(existsSync(executable), "packaged Butler.exe required");
const now = new Date().toISOString();
const fixtures = {
  "butler.config.json": { user: { name: "E2E", language: "ko" }, system: { defaultModel: "openai/gpt-6-luna" }, metrics: { enabled: false } },
  "personalization/onboarding.json": { schema: "butler.first_chat_onboarding.v1", status: "complete", gateway: "any", fields: {}, skipped_fields: [], created_at: now, updated_at: now, completed_at: now },
  "state/scheduler/session-sync.json": { lastRunDate: now.slice(0, 10), lastRunAt: now, status: "ok" },
  "state/scheduler/consolidation-cycle.json": { lastRunDate: now.slice(0, 10), lastRunAt: now, status: "ok" },
};
for (const [path, value] of Object.entries(fixtures)) {
  const target = join(data, path);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, JSON.stringify(value));
}
let toolPath = "";
let step = 0;
const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const body = await request.json();
  const memory = body.text?.format?.name === "memory_meaning_v4";
  const call = !memory && step++ === 0;
  const response = { id: `resp_${crypto.randomUUID()}`, object: "response", status: "completed", model: "gpt-6-luna",
    output: call ? [{ type: "function_call", id: `fc_${crypto.randomUUID()}`, call_id: `call_${crypto.randomUUID()}`,
      name: "write_file", arguments: JSON.stringify({ path: toolPath, content: "permission-smoke", overwrite: false }) }]
      : [{ type: "message", id: `msg_${crypto.randomUUID()}`, role: "assistant", status: "completed",
        content: [{ type: "output_text", text: memory ? JSON.stringify({ status: "processed", entities: [], items: [], attributes: [] }) : "확인 완료", annotations: [] }] }],
    usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } };
  return body.stream ? new Response(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`, { headers: { "content-type": "text/event-stream" } }) : Response.json(response);
} });
const profile = join(dirname(data), "electron-profile");
const env = windowsPowerShellEnvironment(process.env, { USERPROFILE: home,
  LOCALAPPDATA: join(home, "AppData/Local"), APPDATA: join(home, "AppData/Roaming"),
  BUTLER_APP_ELECTRON_USER_DATA_DIR: profile, BUTLER_SECRET_STORE: "file", BUTLER_E2E_TIER: "stub",
  BUTLER_PROVIDER_QUOTA_POLLING: "0", BUTLER_APP_ALLOW_PRECONFIRMED_E2E_QUIT: "1",
  OPENAI_API_KEY: "e2e-not-real", OPENAI_BASE_URL: `http://127.0.0.1:${provider.port}/v1` }) as Record<string, string>;
for (const path of [env.LOCALAPPDATA, env.APPDATA]) mkdirSync(path, { recursive: true });
const owned: OwnedProcesses = new Map();
const app = launchInstalledApp(executable, 0, env, owned);
let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
let page: Page | undefined;
try {
  const devTools = join(profile, "DevToolsActivePort");
  let port = 0;
  await waitFor(() => (port = existsSync(devTools) ? Number(readFileSync(devTools, "utf8").split("\n")[0]) : 0) > 0, "App debugging port");
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const appPage = () => browser!.contexts().flatMap(context => context.pages())
    .find(candidate => candidate.url().startsWith("app://butler/") && !candidate.url().includes("/lifecycle/"));
  await waitFor(() => Boolean(appPage()), "App window");
  page = appPage()!;
  await page.waitForFunction(() => Boolean((window as any).butlerApp));
  ownedProcesses(data, owned);
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  mkdirSync(process.env.BUTLER_PERMISSION_SCREENSHOTS!, { recursive: true });
  const bridge = async (method: string, input?: unknown) => await page!.evaluate(async ({ method, input }) => {
    const result = await (window as any).butlerApp[method](input);
    if (result?.ok === false) throw new Error(`${method}: ${result.error?.code}`);
    return result?.ok === true ? result.data : result;
  }, { method, input });
  await bridge("updateSettings", { onboarding: { consent_version: 2, accepted_at: now, completed_at: now }, model: "openai/gpt-6-luna", language: "ko", access_mode: "ask_first" });
  await bridge("declineButlerVault");
  const { session } = await bridge("createSession", { kind: "chat", title: "Permission smoke" });
  await page.reload();
  await page.locator('[data-slot="composer-compact-preview"]').waitFor();
  const sidebar = page.getByRole("button", { name: "사이드바 보기", exact: true });
  if (await sidebar.isVisible()) await sidebar.click();
  await page.screenshot({ path: join(process.env.BUTLER_PERMISSION_SCREENSHOTS!, "navigation.png"), fullPage: true });
  await page.getByText("Permission smoke", { exact: true }).first().click();
  assert(session?.id, "created session");
  const editor = page.locator('[contenteditable="true"]');
  const output = process.env.BUTLER_PERMISSION_SCREENSHOTS!;
  mkdirSync(output, { recursive: true });
  const choose = async (mode: string, label: string) => {
    if (await page!.locator('[data-slot="composer-compact-preview"]').isVisible()) await page!.locator('[data-slot="composer-compact-preview"]').click();
    await editor.fill("권한 검증");
    await page!.locator('[data-test-class="access-button"]').click();
    const menu = page!.locator('[data-test-class="composer-menu"]');
    assert.equal(await menu.locator('[data-slot="option-menu-item"]').count(), 5);
    await page!.screenshot({ path: join(output, `${mode}-menu.png`), fullPage: true });
    await menu.getByRole("button").filter({ has: page!.getByText(label, { exact: true }) }).click();
    await page!.waitForFunction(label => document.querySelector('[data-test-class="access-button"]')?.getAttribute("aria-label")?.includes(label), label);
    await page!.locator('[data-test-class="composer-menu"]').waitFor({ state: "hidden" });
    await waitFor(async () => (await bridge("getSessionControls", { sessionId: session.id })).controls.access_mode === mode, "agent session mode");
    await page!.screenshot({ path: join(output, `${mode}.png`), fullPage: true });
  };
  let grantsStoredAndHidden = 0;
  for (const [mode, label] of [["full_access", "전체 권한"], ["read_only", "읽기 전용"], ["ask_first", "모두 확인"], ["ask_except_reads", "먼저 확인"]]) {
    await choose(mode!, label!);
    toolPath = join(process.env.HOME!, `${mode}.txt`);
    step = 0;
    const accepted = await bridge("sendMessage", { chatId: session.id, text: "권한 검증 파일 작성", clientMessageId: crypto.randomUUID() });
    const turnId = accepted.turn_id ?? accepted.turn?.turn_id ?? accepted.turn?.id;
    assert(turnId, "accepted tool turn identity");
    await waitFor(async () => {
      const turns = (await bridge("listTurns", { chatId: session.id })).turns;
      return turns.some((turn: any) => turn.id === turnId && ["delivered", "failed", "waiting_for_form"].includes(turn.state));
    }, `tool ${mode}`);
    assert(step >= 1, "stub issued the next write tool call");
    const approvals = await bridge("getAuthorityRequests", { sessionId: session.id });
    if (mode === "full_access") assert.equal(readFileSync(toolPath, "utf8"), "permission-smoke", "full access executes complete next write");
    else if (mode === "read_only") assert(!existsSync(toolPath) && approvals.requests.length === 0, "read only refuses write without approval");
    else {
      assert(!existsSync(toolPath) && approvals.requests.length === 1, "ask first waits before write");
      const ref = approvals.requests[0].request_ref;
      await bridge("allowAuthorityRequest", { sessionId: session.id, requestRef: ref, scope: "conversation" });
      await waitFor(() => existsSync(toolPath), "approved write");
      assert.equal(readFileSync(toolPath, "utf8"), "permission-smoke");
      grantsStoredAndHidden += 1;
      await waitFor(async () => (await bridge("getAuthorityRequests", { sessionId: session.id })).permissions.length === grantsStoredAndHidden, "grant");
      await page.locator('[data-test-class="access-button"]').click();
      const menu = page.locator('[data-test-class="composer-menu"]');
      assert.equal(await menu.locator('[data-slot="option-menu-item"]').count(), 5, "grant does not add menu items");
      assert.equal(await page.locator('[data-test-class="access-button"]').getAttribute("aria-label"), `권한: ${label}`, "grant does not add pill count");
      assert(!(await menu.innerText()).includes("허용한"), "no grant section");
      await page.screenshot({ path: join(output, `${mode}-grant-hidden.png`), fullPage: true });
      await page.keyboard.press("Escape");
    }
  }
  console.log(JSON.stringify({ ok: true, modes: 4, nextToolChecks: 4, grantsStoredAndHidden, appPid: app.pid }));
} finally {
  await page?.evaluate(() => { setTimeout(() => (window as any).butlerApp.quitApp({ confirmed: true }), 50); }).catch(() => {});
  await browser?.close().catch(() => {});
  ownedProcesses(data, owned);
  try { await waitForOwnedExit(owned, "App and Agent quit", () => ownedProcesses(data, owned)); }
  finally {
    for (const { pid } of ownedSurvivors(owned)) { try { process.kill(pid, "SIGKILL"); } catch {} }
    await waitForOwnedExit(owned, "composer smoke process cleanup");
    provider.stop(true);
  }
}
async function waitFor(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 60000;
  while (!await check()) {
    assert(Date.now() < deadline, label);
    assert(app.exitCode === null, "App exited");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
