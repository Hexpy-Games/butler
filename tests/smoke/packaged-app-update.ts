/** Real packaged macOS update, update choices and quit with isolated DATA. */
import { strict as assert } from "node:assert";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, readdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { electronPage, type ElectronPage } from "../support/electron-page-cdp.ts";
import { createMacZip, prepareBundledAgentResource } from "../../packages/butler-app/scripts/release/package-app-release.ts";
import { verifyMacFrameworkLinks, verifyMacPackageMetadata } from "../../deploy/app/native-mac-package-smoke.ts";
import { stageElectronPackageSource } from "../../packages/butler-app/scripts/release/electron-package-source.ts";
import { normalizeMacBundle, signMacBundle } from "../../packages/butler-app/scripts/release/native-mac-signing.ts";
import { updateWorkFixture } from "../support/update-work-fixture.ts";
import { smokeBrowserArgs } from "../support/smoke-browser.ts";
import { freePort } from "../support/native-app-server.ts";
import { FIRST_RUN_CONSENT_VERSION } from "../../packages/butler-app/client/ui/src/app/onboarding.ts";

const root = process.cwd();
const mode = process.env.BUTLER_UPDATE_SMOKE_WORK ?? "idle";
assert.ok(["idle", "now", "defer", "background-quit"].includes(mode));
const work = updateWorkFixture(mode);
const dir = mkdtempSync(join(tmpdir(), "butler-packaged-update-"));
const data = join(dir, "data");
const home = join(dir, "home");
const from = process.env.BUTLER_UPDATE_SMOKE_FROM ?? "0.1.0-preview.90";
const to = process.env.BUTLER_UPDATE_SMOKE_TO ?? "0.1.0-preview.91";
assert.match(from, /^0\.1\.0-preview\.\d+$/u);
assert.match(to, /^0\.1\.0-preview\.\d+$/u);
const profile = process.env.BUTLER_UPDATE_SMOKE_PROFILE ?? "release";
const agentBuilds = process.env.BUTLER_UPDATE_SMOKE_AGENT_BUILDS;
const discovery = process.env.BUTLER_UPDATE_SMOKE_DISCOVERY === "1";
const rust = join(root, "packages/butler-agent/rust");
const target = resolve(process.env.CARGO_TARGET_DIR ?? join(rust, "target"));
const electronRoot = join(root, "packages/butler-app/client/electron");
const logs: string[] = [];
const ownedPids = new Set<number>();
let child: ChildProcess | null = null;
let browser: ElectronPage | null = null;
let server: ReturnType<typeof Bun.serve> | null = null;
const env = { ...process.env, HOME: home, BUTLER_DATA: data, TMPDIR: dir, RUSTC_WRAPPER: "" };

async function run(command: string, args: string[], extra: Record<string, string> = {}, cwd = root) {
  await new Promise<void>((done, fail) => {
    const proc = spawn(command, args, { cwd, env: { ...env, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    proc.stdout.on("data", bytes => { output += String(bytes); });
    proc.stderr.on("data", bytes => { output += String(bytes); });
    proc.on("error", fail);
    proc.on("exit", code => code === 0 ? done() : fail(new Error(`${command} failed (${code}): ${output.slice(-8000)}`)));
  });
}

async function packageVersion(version: string) {
  const cache = process.env.BUTLER_UPDATE_SMOKE_BUNDLE_CACHE;
  const cached = cache ? join(cache, version, "Butler.app") : null;
  if (cached && await Bun.file(join(cached, "Contents/Info.plist")).exists()) return cached;
  const tagEnv = { GITHUB_REF_NAME: `v${version}`, CARGO_PROFILE_DEV_DEBUG: "0", CARGO_PROFILE_DEV_INCREMENTAL: "false" };
  if (!agentBuilds) await run("cargo", ["build", "--locked", "--profile", profile, "-p", "butler-agent", "--bin", "butler-agent", "--no-default-features", "--features", "static-ort"], tagEnv, rust);
  const work = join(dir, version);
  mkdirSync(work);
  const binary = join(work, "butler-agent");
  cpSync(agentBuilds ? join(agentBuilds, version, "butler-agent") : join(target, profile === "dev" ? "debug" : profile, "butler-agent"), binary);
  Object.assign(process.env, env, tagEnv, { BUTLER_NATIVE_AGENT_EXECUTABLE: binary });
  const payload = prepareBundledAgentResource(root, work, "darwin-arm64");
  const source = stageElectronPackageSource(root, join(work, "source"));
  const pkg = JSON.parse(readFileSync(join(electronRoot, "package.json"), "utf8"));
  const icon = join(work, "butler-release-icon.icns");
  cpSync(join(electronRoot, "assets/butler.icns"), icon);
  await run("node", [join(electronRoot, "node_modules/@electron/packager/bin/electron-packager.mjs"), source, "Butler",
    "--platform=darwin", "--arch=arm64", `--electron-version=${pkg.devDependencies.electron}`, "--overwrite",
    `--out=${work}`, "--app-bundle-id=com.hexpy.butler", "--helper-bundle-id=com.hexpy.butler.helper",
    `--icon=${icon}`, `--extra-resource=${payload.resourceDir}`,
    `--extra-resource=${join(root, "packages/butler-app/client/ui/dist")}`, "--quiet"], tagEnv);
  const bundle = join(work, "Butler-darwin-arm64/Butler.app");
  // The release packager names the separate renderer resource app-client.
  cpSync(join(root, "packages/butler-app/client/ui/dist"), join(bundle, "Contents/Resources/app-client"), { recursive: true });
  normalizeMacBundle(root, bundle);
  signMacBundle(root, bundle);
  const versionOutput = spawnSync(binary, ["--version"], { env, encoding: "utf8" });
  assert.equal(versionOutput.status, 0);
  assert.match(versionOutput.stdout, new RegExp(version.replaceAll(".", "\\.")));
  console.log(`PACKAGED ${version}: ${versionOutput.stdout.trim()}`);
  if (cached) {
    await run("ditto", [bundle, cached]);
    return cached;
  }
  return bundle;
}

async function connect(port: number) {
  const page = await electronPage(port);
  await page.waitForFunction(() => document.readyState === "complete" && Boolean(window.butlerApp));
  const instance = JSON.parse(readFileSync(join(data, "app/runtime/foreground/instance.json"), "utf8"));
  ownedPids.add(instance.app_pid);
  return { browser: page, page };
}

async function clickNamed(page: ElectronPage, name: string) {
  const find = `Array.from(document.querySelectorAll('button, [role="button"]')).find(e => (e.getAttribute('aria-label') || e.textContent).trim() === ${JSON.stringify(name)})`;
  assert.ok(await page.expression(`Boolean(${find})`), `Button missing: ${name}`);
  await page.expression(`(${find}).click()`);
}

async function proof(page: ElectronPage, version: string, sessionId?: string) {
  const installed = join(dir, "installed/Butler.app");
  verifyMacPackageMetadata(installed, version, true);
  await run("codesign", ["--verify", "--deep", "--strict", installed]);
  console.log(`STRUCTURE ${version}: ${JSON.stringify(verifyMacFrameworkLinks(installed))}, Agent links read-only, signature valid`);
  const facts = await page.evaluate(async () => {
    const bridge = window.butlerApp as Record<string, (...args: unknown[]) => Promise<unknown>>;
    return { info: await bridge.getAppInfo(), health: await bridge.health(), sessions: await bridge.listSessions(), settings: await bridge.getSettings(), updates: await bridge.getUpdates() };
  }) as { info: { version: string }; updates: { components: Array<{ current_version: string; bundled_agent_version: string }> }; health: unknown; sessions: { sessions: Array<{ id: string; title: string }> }; settings: { update_previews: boolean } };
  assert.equal(facts.info.version, version);
  assert.equal((facts.health as { ok: boolean }).ok, true);
  assert.equal(facts.updates.components[0].current_version, version);
  const payload = JSON.parse(readFileSync(join(dir, "installed/Butler.app/Contents/Resources/bundled-agent/native-agent-manifest.json"), "utf8"));
  assert.equal(payload.version, version);
  assert.equal(statSync(join(dir, "installed/Butler.app/Contents/Resources/bundled-agent/bin/butler-agent")).mode & 0o777, 0o555);
  if (sessionId) assert.ok(facts.sessions.sessions.some(s => s.id === sessionId && s.title === "Update keeps this chat"));
  assert.equal(readFileSync(join(data, "update-sentinel.txt"), "utf8"), "preserved");
  console.log(`PROOF ${JSON.stringify({ version: facts.info.version, bundledAgent: facts.updates.components[0].current_version, health: facts.health, dataPreserved: true, sessionPreserved: Boolean(sessionId), previews: facts.settings.update_previews })}`);
}

async function serveUpdate(zip: string) {
  const sha256 = new Bun.CryptoHasher("sha256").update(await Bun.file(zip).arrayBuffer()).digest("hex");
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, async fetch(request) {
    if (new URL(request.url).pathname === "/v1/chat/completions") return work.provider(request);
    return new URL(request.url).pathname === "/update.zip" ? new Response(Bun.file(zip)) : Response.json({ artifacts: [{
      component: "app", product: "butler-app", platform: "darwin-arm64", version: to, channel: "preview", bundled_agent_version: to,
      artifact_url: `http://127.0.0.1:${server!.port}/update.zip`, sha256,
      staging_policy: "butler-data-updates", activation_policy: "user-installs-app-package", rollback_policy: "not-managed-by-butler",
    }] });
  } });
  writeFileSync(join(data, "butler.config.json"), JSON.stringify({
    user: { language: "en" }, metrics: { enabled: false }, system: { defaultModel: "local/stub" },
    models: { local: [{ model_id: "stub", display_name: "Stub", server_url: `http://127.0.0.1:${server.port}`,
      context_window_tokens: 128000 }] },
  }));
  return server.port;
}

async function smoke() {
  mkdirSync(home); mkdirSync(data);
  seedBackgroundOwners();
  writeFileSync(join(data, "update-sentinel.txt"), "preserved");
  const first = process.env.BUTLER_UPDATE_SMOKE_FROM_BUNDLE ?? await packageVersion(from);
  const second = process.env.BUTLER_UPDATE_SMOKE_TO_BUNDLE ?? await packageVersion(to);
  await run("xattr", ["-w", "com.apple.quarantine", "0081;66000000;ButlerSmoke;", second]);
  const zip = join(dir, "update.zip");
  createMacZip(second, zip);
  const updatePort = await serveUpdate(zip);
  const installed = join(dir, "installed/Butler.app");
  // Match installation from the release DMG: preserve relative framework links,
  // Agent hard links and modes. Bun/Node cpSync can rewrite links to the source.
  await run("ditto", [first, installed]);
  verifyMacPackageMetadata(installed, from, true);
  const debugPort = await freePort(), agentPort = await freePort();
  child = spawn(join(installed, "Contents/MacOS/Butler"), [`--remote-debugging-port=${debugPort}`, ...smokeBrowserArgs()], { env: {
    ...env, BUTLER_APP_SERVER_PORT: String(agentPort), BUTLER_APP_ELECTRON_USER_DATA_DIR: join(dir, "profile"),
    BUTLER_APP_UPDATE_MANIFEST: discovery ? "" : process.env.BUTLER_UPDATE_SMOKE_MANIFEST ?? `http://127.0.0.1:${updatePort}/manifest.json`,
    ...(discovery ? { BUTLER_UPDATE_MANIFEST: "", BUTLER_UPDATE_RELEASES_API: "" } : {}),
    BUTLER_APP_ALLOW_PRECONFIRMED_E2E_QUIT: "1",
    BUTLER_E2E_TIER: "stub", BUTLER_E2E_EMBED_SOURCES: "http://127.0.0.1:9",
    ...(mode === "background-quit" ? { BUTLER_E2E_HOLD_MEMORY_BOOTSTRAP: "1" } : {}),
  }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout!.on("data", bytes => logs.push(String(bytes))); child.stderr!.on("data", bytes => logs.push(String(bytes)));
  child.on("exit", (code, signal) => logs.push(`App exited: code=${code}, signal=${signal}\n`));
  console.log(`LAUNCH ${from}: ${installed}`);
  if (discovery) console.log(`DISCOVERY ${from}: fresh process, default published release API, no manifest override`);
  let connected = await connect(debugPort); browser = connected.browser;
  const page = connected.page;
  const completedAt = new Date().toISOString();
  await page.expression(`window.butlerApp.updateSettings(${JSON.stringify({ language: "en", onboarding: {
    consent_version: FIRST_RUN_CONSENT_VERSION, accepted_at: completedAt, completed_at: completedAt,
  } })})`);
  await page.reload();
  await proof(page, from);
  const created = await page.evaluate(async () => (window.butlerApp!.createSession as (v: unknown) => Promise<{ session: { id: string } }>)({ kind: "chat", title: "Update keeps this chat" }));
  const session = created.session;
  assert.ok(session?.id, "Created chat ID is missing.");
  if (mode === "background-quit") {
    // Real background bootstrap is held by the existing stub-tier hook.
    assert.ok(await Bun.file(join(data, "cognition/memory/fresh-initialization.json")).exists());
    assert.equal(await Bun.file(join(data, "cognition/memory/active-generation.json")).exists(), false);
    // An enabled future schedule is configuration, not running user work.
    const scheduled = await page.expression<{ ok: boolean }>(`window.butlerApp.createAutomation(${JSON.stringify({
      title: "Future schedule", promptBody: "Scheduled stub", targetSessionId: session.id,
      scheduleType: "once", runAt: "2099-10-03T00:00:00Z", accessMode: "ask_first",
    })})`);
    assert.equal(scheduled.ok, true, "future schedule was accepted");
    await page.expression("window.butlerApp.quitApp()");
    await waitForOldExit();
    console.log("PASS background-only quit: no warning, native service stopped");
    return;
  }
  await page.waitForFunction(() => Array.from(document.querySelectorAll('button, [role="button"]')).some(e => e.getAttribute("aria-label") === "Settings" || e.textContent?.trim() === "Settings"));
  await clickNamed(page, "Settings");
  await clickNamed(page, "Updates");
  await page.waitForFunction(() => Boolean(document.querySelector("[data-test-id='update-component-app'] button")));
  assert.equal(await page.expression(`document.querySelector("[data-setting-id='update-previews'] [role='switch']").getAttribute('aria-checked')`), "false");
  await page.waitForFunction(() => document.querySelector("[data-test-id='update-component-app'] button")?.hasAttribute("disabled"));
  const rowText = () => page.expression<string>(`document.querySelector('[data-test-id="update-component-app"]').innerText`);
  console.log(`OFF: ${await rowText()} (preview hidden)`);
  await page.waitForFunction(() => !document.querySelector("[data-setting-id='update-previews'] [role='switch']")?.hasAttribute("disabled"));
  await page.expression(`document.querySelector("[data-setting-id='update-previews'] [role='switch']").click()`);
  await page.waitForFunction(() => !document.querySelector("[data-test-id='update-component-app'] button")?.hasAttribute("disabled"));
  assert.ok((await rowText()).includes(to), "Settings shows the exact candidate version");
  console.log(`ON: ${await rowText()}`);
  if (mode === "now" || mode === "defer") await work.start(page, session.id);
  await page.expression(`document.querySelector("[data-test-id='update-component-app'] button").click()`);
  if (mode === "now" || mode === "defer") await work.choose(page);
  await waitForOldExit();
  await browser.close(); browser = null;
  console.log(`RELAUNCH ${to}: ${installed}`);
  connected = await connect(debugPort); browser = connected.browser;
  await proof(connected.page, to, session.id);
  if (mode === "now" || mode === "defer") await work.verify(connected.page);
  await connected.page.evaluate(() => (window.butlerApp!.quitApp as (v: unknown) => Promise<unknown>)({ confirmed: true }));
  console.log(`PASS packaged App ${from} -> ${to}: UI update, checksum/signature, relaunch, healthy Agent, same DATA/chat`);
}

async function waitForOldExit() {
  await new Promise<void>((done, fail) => {
    const exited = (code: number | null) => {
      clearTimeout(timer);
      if (code === 0) done();
      else fail(new Error(`App exit code: ${code}`));
    };
    const timer = setTimeout(() => {
      child!.removeListener("exit", exited);
      fail(new Error(`Old App did not exit: ${logs.join("").slice(-6000)}`));
    }, 60_000);
    child!.once("exit", exited);
    if (child!.exitCode !== null) { child!.removeListener("exit", exited); exited(child!.exitCode); }
  });
}

function seedBackgroundOwners() {
  const now = new Date().toISOString();
  mkdirSync(join(data, "state/scheduler"), { recursive: true });
  for (const id of ["session-sync", "consolidation-cycle"]) {
    writeFileSync(join(data, `state/scheduler/${id}.json`), JSON.stringify({ lastRunDate: now.slice(0, 10), lastRunAt: now, status: "ok" }));
  }
  mkdirSync(join(data, "personalization"), { recursive: true });
  writeFileSync(join(data, "personalization/onboarding.json"), JSON.stringify({
    schema: "butler.first_chat_onboarding.v1", status: "complete", gateway: "any",
    fields: {}, skipped_fields: [], created_at: now, updated_at: now, completed_at: now,
  }));
}

async function cleanup() {
  work.release();
  browser?.close();
  try {
    const instance = JSON.parse(readFileSync(join(data, "app/runtime/foreground/instance.json"), "utf8"));
    ownedPids.add(instance.app_pid); ownedPids.add(instance.agent_host_pid);
  } catch { /* App never started. */ }
  if (child && child.exitCode === null) child.kill("SIGTERM");
  for (const pid of ownedPids) {
    try { process.kill(pid, "SIGTERM"); } catch { /* Already exited. */ }
  }
  server?.stop(true);
  // Allow the App's confirmed graceful quit to finish before removing its DATA.
  await new Promise(done => setTimeout(done, 1500));
  makeWritable(dir);
  rmSync(dir, { recursive: true, force: true });
}

function makeWritable(path: string) {
  if ((statSync(path).mode & 0o200) === 0) chmodSync(path, statSync(path).mode | 0o200);
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isDirectory()) makeWritable(join(path, entry.name));
  }
}

try { await smoke(); } catch (error) {
  try { console.error(readFileSync(join(data, "updates/app-install.log"), "utf8")); } catch { /* Helper not started. */ }
  console.error("Electron main-process log:\n" + logs.join(""));
  for (const name of ["startup-progress.json", "startup-failure.json", "last-exit.json"]) {
    try { console.error(`${name}: ${readFileSync(join(data, "app/runtime/foreground", name), "utf8")}`); } catch { /* Not published. */ }
  }
  const bundle = join(dir, "installed/Butler.app");
  for (const [command, args] of [
    ["codesign", ["-dv", "--verbose=4", bundle]],
    ["spctl", ["-a", "-vv", bundle]],
  ] as const) {
    const result = spawnSync(command, [...args], { env, encoding: "utf8" });
    console.error(`${command} (informational, status=${result.status}):\n${result.stdout}${result.stderr}`);
  }
  console.error(error); throw error;
} finally { await cleanup(); }
