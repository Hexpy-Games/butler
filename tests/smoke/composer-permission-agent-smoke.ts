// UI smoke: real agent controls, tool authority and original permission menu and next-tool authority.
import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { smokeBrowserArgs } from "../support/smoke-browser.ts";

const packageRoot = resolve(process.argv[2]!);
const data = process.env.BUTLER_DATA!;
assert(data && process.env.HOME && process.env.BUTLER_APP_DISABLE_SHELL_REGISTRATION === "1", "isolated launcher required");
const binary = join(packageRoot, "butler-agent.exe");
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
const agent = spawn(binary, ["--installation-root", packageRoot, "--resource-root", join(packageRoot, "resources"), "service", "run", "--data", data], {
  stdio: "ignore", env: { ...process.env, BUTLER_APP_SERVER_HOST: "127.0.0.1", BUTLER_APP_SERVER_PORT: "0",
    BUTLER_SERVICE_MANAGER: "off", BUTLER_SECRET_STORE: "file", BUTLER_PLATFORM_SYSTEM_SECRETS: "0", BUTLER_E2E_TIER: "stub",
    OPENAI_API_KEY: "e2e-not-real", OPENAI_BASE_URL: `http://127.0.0.1:${provider.port}/v1`, BUTLER_PROVIDER_QUOTA_POLLING: "0" },
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  browser = await chromium.launch({ headless: true, args: smokeBrowserArgs(),
    ...(process.env.BUTLER_SMOKE_BROWSER_EXECUTABLE ? { executablePath: process.env.BUTLER_SMOKE_BROWSER_EXECUTABLE } : {}) });
  const instancePath = join(data, "state/butler-agent-native-service.json");
  await waitFor(() => existsSync(instancePath) && JSON.parse(readFileSync(instancePath, "utf8")).state === "ready", "agent ready");
  const opened = spawnSync(binary, ["open", "--data", data, "--no-browser", "--json"], { encoding: "utf8" });
  assert.equal(opened.status, 0, "connection link");
  const connect = JSON.parse(opened.stdout).data.url;
  const origin = new URL(connect).origin;
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, reducedMotion: "reduce" });
  mkdirSync(process.env.BUTLER_PERMISSION_SCREENSHOTS!, { recursive: true });
  await page.goto(connect);
  const api = async (path: string, method = "GET", body?: unknown) => await page.evaluate(async ({ path, method, body }) => {
    const response = await fetch(path, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw new Error(`API ${path}: ${response.status}`);
    return (await response.json()).data;
  }, { path, method, body });
  await api("/settings", "PATCH", { onboarding: { consent_version: 2, accepted_at: now, completed_at: now }, model: "openai/gpt-6-luna", language: "ko", access_mode: "ask_first" });
  const { session } = await api("/sessions", "POST", { kind: "chat", title: "Permission smoke" });
  await page.goto(`${origin}/`);
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
    if (await page.locator('[data-slot="composer-compact-preview"]').isVisible()) await page.locator('[data-slot="composer-compact-preview"]').click();
    await editor.fill("권한 검증");
    await page.locator('[data-test-class="access-button"]').click();
    const menu = page.locator('[data-test-class="composer-menu"]');
    assert.equal(await menu.locator('[data-slot="option-menu-item"]').count(), 3);
    await page.screenshot({ path: join(output, `${mode}-menu.png`), fullPage: true });
    await menu.getByRole("button").filter({ has: page.getByText(label, { exact: true }) }).click();
    await page.waitForFunction(label => document.querySelector('[data-test-class="access-button"]')?.getAttribute("aria-label")?.includes(label), label);
    await page.locator('[data-test-class="composer-menu"]').waitFor({ state: "hidden" });
    await waitFor(async () => (await api(`/sessions/${session.id}/controls`)).controls.access_mode === mode, "agent session mode");
    await page.screenshot({ path: join(output, `${mode}.png`), fullPage: true });
  };
  for (const [mode, label] of [["full_access", "전체 권한"], ["read_only", "읽기 전용"], ["ask_first", "모두 확인"]]) {
    await choose(mode!, label!);
    toolPath = join(process.env.HOME!, `${mode}.txt`);
    step = 0;
    const accepted = await api("/messages", "POST", { chat_id: session.id, text: "권한 검증 파일 작성", client_message_id: crypto.randomUUID() });
    const turnId = accepted.turn_id ?? accepted.turn?.turn_id ?? accepted.turn?.id;
    assert(turnId, "accepted tool turn identity");
    await waitFor(async () => {
      const turns = (await api(`/turns?chat_id=${session.id}`)).turns;
      return turns.some((turn: any) => turn.id === turnId && ["delivered", "failed", "waiting_for_form"].includes(turn.state));
    }, `tool ${mode}`);
    assert(step >= 1, "stub issued the next write tool call");
    const approvals = await api(`/authority-requests?session_id=${session.id}`);
    if (mode === "full_access") assert.equal(readFileSync(toolPath, "utf8"), "permission-smoke", "full access executes complete next write");
    else if (mode === "read_only") assert(!existsSync(toolPath) && approvals.requests.length === 0, "read only refuses write without approval");
    else {
      assert(!existsSync(toolPath) && approvals.requests.length === 1, "ask first waits before write");
      const ref = approvals.requests[0].request_ref;
      await api(`/authority-requests/${ref}/allow?session_id=${session.id}`, "POST", { scope: "conversation" });
      await waitFor(() => existsSync(toolPath), "approved write");
      assert.equal(readFileSync(toolPath, "utf8"), "permission-smoke");
      await waitFor(async () => (await api(`/authority-requests?session_id=${session.id}`)).permissions.length === 1, "grant");
      await page.locator('[data-test-class="access-button"]').click();
      const menu = page.locator('[data-test-class="composer-menu"]');
      assert.equal(await menu.locator('[data-slot="option-menu-item"]').count(), 3, "grant does not add menu items");
      assert.equal(await page.locator('[data-test-class="access-button"]').getAttribute("aria-label"), "권한: 먼저 확인", "grant does not add pill count");
      assert(!(await menu.innerText()).includes("허용한"), "no grant section");
      await page.screenshot({ path: join(output, "grant-hidden.png"), fullPage: true });
      await page.keyboard.press("Escape");
    }
  }
  console.log(JSON.stringify({ ok: true, modes: 3, nextToolChecks: 3, grantsStoredAndHidden: 1, agentPid: agent.pid }));
} finally {
  await browser?.close(); provider.stop(true);
  spawnSync(binary, ["stop", "--data", data, "--quiet"], { stdio: "ignore" });
  if (agent.exitCode === null) await Promise.race([new Promise(resolve => agent.once("exit", resolve)), new Promise(resolve => setTimeout(resolve, 10000))]);
  if (agent.exitCode === null) agent.kill();
}
async function waitFor(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 60000;
  while (!await check()) {
    assert(Date.now() < deadline, label);
    assert(agent.exitCode === null, "agent exited");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
