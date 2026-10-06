import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { freePort } from "../support/native-app-server.ts";
import { electronPage } from "../support/electron-page-cdp.ts";
import { mainInspector } from "../support/electron-main-inspector.ts";
import { smokeElectronArgs } from "../support/smoke-browser.ts";
import { FIRST_RUN_CONSENT_VERSION } from "../../packages/butler-app/client/ui/src/app/onboarding.ts";

export const P0_STUB_CONTENT = Array.from({ length: 300 }, (_, i) => `스트리밍 응답 ${i}입니다.`).join(" ");

export async function waitFor(read: () => Promise<unknown>, label: string, timeout = 30_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await read()) return; await Bun.sleep(100); }
  throw new Error(`Timed out: ${label}`);
}

export async function launchP0App({ harness = true } = {}) {
  const binary = process.env.BUTLER_NATIVE_AGENT_EXECUTABLE || resolve(process.env.CARGO_TARGET_DIR || "target", "debug", process.platform === "win32" ? "butler-agent.exe" : "butler-agent");
  assert(existsSync(binary), "Build the native Agent or set BUTLER_NATIVE_AGENT_EXECUTABLE");
  const dir = mkdtempSync(join(tmpdir(), "butler-browser-p0-"));
  const home = join(dir, "home"), data = join(dir, "data");
  mkdirSync(home); mkdirSync(data); mkdirSync(join(dir, "installation"));
  const installed = join(dir, "installation", process.platform === "win32" ? "butler-agent.exe" : "butler-agent");
  copyFileSync(binary, installed);
  cpSync("packages/butler-agent/resources", join(dir, "installation/resources"), { recursive: true });
  cpSync("packages/butler-app/client/ui/dist", join(dir, "installation/resources/app-client/dist"), { recursive: true });
  const stub = createStreamingStub();
  writeFileSync(join(data, "butler.config.json"), JSON.stringify({ user: { name: "Smoke", language: "ko" }, system: { defaultModel: "local/stub" }, models: { local: [{ model_id: "stub", display_name: "Stub", server_url: `http://127.0.0.1:${stub.port}`, context_window_tokens: 128000 }] }, metrics: { enabled: false } }));
  const at = new Date().toISOString();
  mkdirSync(join(data, "personalization"));
  writeFileSync(join(data, "personalization/onboarding.json"), JSON.stringify({ schema: "butler.first_chat_onboarding.v1", status: "complete", gateway: "any", fields: {}, skipped_fields: [], created_at: at, updated_at: at, completed_at: at }));
  const inspector = await freePort(), debug = await freePort();
  const executable = process.env.BUTLER_SMOKE_ELECTRON_EXECUTABLE || resolve(process.platform === "win32" ? "packages/butler-app/client/electron/node_modules/electron/dist/electron.exe" : "packages/butler-app/client/electron/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  const args = smokeElectronArgs();
  assert(!args.includes("--single-process"), "P0 needs independent GPU and renderer processes");
  const child = spawn(executable, [resolve("packages/butler-app/client/electron"), `--inspect=${inspector}`, `--remote-debugging-port=${debug}`, ...args], { env: {
    ...process.env, HOME: home, USERPROFILE: home, BUTLER_DATA: data, CODEX_HOME: join(home, ".codex"), TMPDIR: dir, TEMP: dir, TMP: dir,
    BUTLER_NATIVE_AGENT_EXECUTABLE: installed, BUTLER_TEST_BROWSER_P0: harness ? "1" : "0", BUTLER_E2E_TIER: "stub",
    BUTLER_APP_ELECTRON_USER_DATA_DIR: join(dir, "profile"), BUTLER_APP_SERVER_PORT: String(await freePort()),
    BUTLER_APP_ALLOW_PRECONFIRMED_E2E_QUIT: "1", BUTLER_APP_DISABLE_SHELL_REGISTRATION: "1",
    BUTLER_E2E_EMBED_SOURCES: "http://127.0.0.1:9",
  }, stdio: ["ignore", "pipe", "pipe"] });
  const logs: string[] = [];
  child.stdout!.on("data", value => logs.push(String(value))); child.stderr!.on("data", value => logs.push(String(value)));
  let page: Awaited<ReturnType<typeof electronPage>> | undefined;
  let main: Awaited<ReturnType<typeof mainInspector>> | undefined;
  async function stop() {
    // Foreground runtime PID comes only from our disposable installation.
    let agentPid = 0;
    try { agentPid = JSON.parse(readFileSync(join(data, "app/runtime/foreground/instance.json"), "utf8")).agent_host_pid; } catch {}
    if (page) await page.expression("window.butlerApp.quitApp({confirmed:true})").catch(() => {});
    page?.close(); main?.close();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await Bun.sleep(1500);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    if (Number.isInteger(agentPid) && agentPid > 0) { try { process.kill(agentPid, "SIGTERM"); } catch {} }
    if (agentPid > 0) {
      await Bun.sleep(1000);
      try { process.kill(agentPid, 0); process.kill(agentPid, "SIGKILL"); } catch {}
    }
    stub.stop(true); rmSync(dir, { recursive: true, force: true });
  }
  try {
    main = await mainInspector(inspector, () => child.exitCode === null && child.signalCode === null);
    page = await electronPage(debug);
    if (harness) await waitFor(() => main!.evaluate("Boolean(globalThis.browserP0)"), "P0 harness");
    await waitFor(() => page!.expression("window.butlerApp.health().then(r=>r.ok)"), "Agent health");
    await page.expression(`window.butlerApp.updateSettings(${JSON.stringify({ language: "ko", onboarding: { consent_version: FIRST_RUN_CONSENT_VERSION, accepted_at: at, completed_at: at }, wallpaper: { source: { kind: "live", module: "butler.silk", params: {}, paramsDark: {} }, motion: "auto", pauseOnBattery: false } })})`);
    await page.reload();
    await page.waitForFunction(() => Boolean(document.querySelector('[data-test-class="workspace"]')));
    return { dir, data, page, main, child, stop };
  } catch (error) {
    // Logs can include bearer-bearing URLs: do not print raw App logs.
    await stop(); throw new Error(`App launch failed (${child.exitCode ?? child.signalCode ?? "running"}): ${String(error)}; ${logs.join("").length} log bytes withheld; Mach rendezvous=${/Mach|rendezvous/iu.test(logs.join(""))}`, { cause: error });
  }
}

function createStreamingStub() {
  return Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { stream?: boolean };
    const content = P0_STUB_CONTENT;
    if (!body.stream) return Response.json({ id: "p0", object: "chat.completion", model: "stub", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] });
    const stream = new ReadableStream({ async start(controller) {
      for (const text of content.match(/.{1,12}/gu)!) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: "p0", object: "chat.completion.chunk", model: "stub", choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`));
        await Bun.sleep(100);
      }
      controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n")); controller.close();
    } });
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  } });
}
