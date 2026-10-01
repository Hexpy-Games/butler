/** Real packaged macOS .90 -> .91 update through Settings, with isolated DATA. */
import { strict as assert } from "node:assert";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, readdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { electronPage, type ElectronPage } from "../support/electron-page-cdp.ts";
import { prepareBundledAgentResource } from "../../packages/butler-app/scripts/release/package-app-release.ts";
import { stageElectronPackageSource } from "../../packages/butler-app/scripts/release/electron-package-source.ts";
import { normalizeMacBundle, signMacBundle } from "../../packages/butler-app/scripts/release/native-mac-signing.ts";
import { freePort } from "../support/native-app-server.ts";

const root = process.cwd();
const dir = mkdtempSync(join(tmpdir(), "butler-packaged-update-"));
const data = join(dir, "data");
const home = join(dir, "home");
const from = "0.1.0-preview.90", to = "0.1.0-preview.91";
const profile = process.env.BUTLER_UPDATE_SMOKE_PROFILE ?? "release";
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
  const tagEnv = { GITHUB_REF_NAME: `v${version}`, CARGO_PROFILE_DEV_DEBUG: "0", CARGO_PROFILE_DEV_INCREMENTAL: "false" };
  await run("cargo", ["build", "--locked", "--profile", profile, "-p", "butler-agent", "--bin", "butler-agent", "--no-default-features", "--features", "static-ort"], tagEnv, rust);
  const work = join(dir, version);
  mkdirSync(work);
  const binary = join(work, "butler-agent");
  cpSync(join(target, profile === "dev" ? "debug" : profile, "butler-agent"), binary);
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
  return bundle;
}

async function connect(port: number) {
  const page = await electronPage(port);
  await page.waitForFunction(() => Boolean(window.butlerApp));
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
  const facts = await page.evaluate(async () => {
    const bridge = window.butlerApp as Record<string, (...args: unknown[]) => Promise<unknown>>;
    return { info: await bridge.getAppInfo(), health: await bridge.health(), sessions: await bridge.listSessions(), settings: await bridge.getSettings(), updates: await bridge.getUpdates() };
  }) as { info: { version: string }; updates: { components: Array<{ current_version: string; bundled_agent_version: string }> }; health: unknown; sessions: Array<{ id: string; title: string }>; settings: { update_previews: boolean } };
  assert.equal(facts.info.version, version);
  assert.equal((facts.health as { ok: boolean }).ok, true);
  assert.equal(facts.updates.components[0].current_version, version);
  const payload = JSON.parse(readFileSync(join(dir, "installed/Butler.app/Contents/Resources/bundled-agent/native-agent-manifest.json"), "utf8"));
  assert.equal(payload.version, version);
  if (sessionId) assert.ok(facts.sessions.some(s => s.id === sessionId && s.title === "Update keeps this chat"));
  assert.equal(readFileSync(join(data, "update-sentinel.txt"), "utf8"), "preserved");
  console.log(`PROOF ${JSON.stringify({ version: facts.info.version, bundledAgent: facts.updates.components[0].current_version, health: facts.health, dataPreserved: true, sessionPreserved: Boolean(sessionId), previews: facts.settings.update_previews })}`);
}

async function smoke() {
  mkdirSync(home); mkdirSync(data);
  writeFileSync(join(data, "butler.config.json"), JSON.stringify({ user: { language: "en" }, metrics: { enabled: false } }));
  writeFileSync(join(data, "update-sentinel.txt"), "preserved");
  const first = await packageVersion(from), second = await packageVersion(to);
  await run("xattr", ["-w", "com.apple.quarantine", "0081;66000000;ButlerSmoke;", second]);
  const zip = join(dir, "update.zip");
  await run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", second, zip]);
  const sha256 = new Bun.CryptoHasher("sha256").update(await Bun.file(zip).arrayBuffer()).digest("hex");
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch(request) {
    return new URL(request.url).pathname === "/update.zip" ? new Response(Bun.file(zip)) : Response.json({ artifacts: [{
      component: "app", product: "butler-app", platform: "darwin-arm64", version: to, channel: "preview", bundled_agent_version: to,
      artifact_url: `http://127.0.0.1:${server!.port}/update.zip`, sha256,
      staging_policy: "butler-data-updates", activation_policy: "user-installs-app-package", rollback_policy: "not-managed-by-butler",
    }] });
  } });
  const installed = join(dir, "installed/Butler.app");
  cpSync(first, installed, { recursive: true });
  const debugPort = await freePort(), agentPort = await freePort();
  child = spawn(join(installed, "Contents/MacOS/Butler"), [`--remote-debugging-port=${debugPort}`], { env: {
    ...env, BUTLER_APP_SERVER_PORT: String(agentPort), BUTLER_APP_ELECTRON_USER_DATA_DIR: join(dir, "profile"),
    BUTLER_APP_UPDATE_MANIFEST: `http://127.0.0.1:${server.port}/manifest.json`, BUTLER_APP_ALLOW_PRECONFIRMED_E2E_QUIT: "1",
  }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout!.on("data", bytes => logs.push(String(bytes))); child.stderr!.on("data", bytes => logs.push(String(bytes)));
  child.on("exit", (code, signal) => logs.push(`App exited: code=${code}, signal=${signal}\n`));
  let connected = await connect(debugPort); browser = connected.browser;
  const page = connected.page;
  await page.evaluate(async () => {
    const bridge = window.butlerApp as Record<string, (...args: unknown[]) => Promise<unknown>>;
    await bridge.updateSettings({ language: "en", onboarding: { consent_version: 1, accepted_at: new Date().toISOString(), completed_at: new Date().toISOString() } });
  });
  await page.reload();
  await proof(page, from);
  const session = await page.evaluate(async () => (window.butlerApp!.createSession as (v: unknown) => Promise<{ id: string }>)({ kind: "chat", title: "Update keeps this chat" }));
  await page.waitForFunction(() => Array.from(document.querySelectorAll("button")).some(e => e.getAttribute("aria-label") === "Settings" || e.textContent?.trim() === "Settings"));
  await clickNamed(page, "Settings");
  await clickNamed(page, "Updates");
  await page.waitForFunction(() => Boolean(document.querySelector('[data-test-id="update-component-app"] button')));
  assert.equal(await page.expression(`document.querySelector('[data-setting-id="update-previews"] [role="switch"]').getAttribute('aria-checked')`), "false");
  await page.waitForFunction(() => document.querySelector('[data-test-id="update-component-app"] button')?.hasAttribute("disabled"));
  const rowText = () => page.expression<string>(`document.querySelector('[data-test-id="update-component-app"]').innerText`);
  console.log(`OFF: ${await rowText()} (preview hidden)`);
  await page.expression(`document.querySelector('[data-setting-id="update-previews"] [role="switch"]').click()`);
  await page.waitForFunction(() => !document.querySelector('[data-test-id="update-component-app"] button')?.hasAttribute("disabled"));
  assert.match(await rowText(), /0\.1\.0-preview\.91/);
  console.log(`ON: ${await rowText()}`);
  await page.expression(`document.querySelector('[data-test-id="update-component-app"] button').click()`);
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`Old App did not exit: ${logs.join("").slice(-6000)}`)), 60_000);
    child!.once("exit", code => { clearTimeout(timer); assert.equal(code, 0); done(); });
  });
  await browser.close(); browser = null;
  connected = await connect(debugPort); browser = connected.browser;
  await proof(connected.page, to, session.id);
  await connected.page.evaluate(() => (window.butlerApp!.quitApp as (v: unknown) => Promise<unknown>)({ confirmed: true }));
  console.log("PASS packaged App .90 -> .91: UI update, checksum/signature, relaunch, healthy Agent, same DATA/chat");
}

async function cleanup() {
  browser?.close();
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
  chmodSync(path, 0o700);
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isDirectory()) makeWritable(join(path, entry.name));
  }
}

try { await smoke(); } catch (error) { console.error(logs.join("").slice(-8000)); console.error(error); throw error; } finally { await cleanup(); }
