import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { prepareBundledAgentResource } from "../../packages/butler-app/scripts/release/package-app-release.ts";

const root = process.cwd();
const electronBin = resolve(
  root,
  "packages",
  "butler-app",
  "client",
  "electron",
  "node_modules",
  ".bin",
  process.platform === "win32" ? "electron.cmd" : "electron",
);
const electronAppRoot = resolve(
  root,
  "packages",
  "butler-app",
  "client",
  "electron",
);
const uiRoot = resolve(root, "packages", "butler-app", "client", "ui", "dist");
const tempDir = mkdtempSync(join(tmpdir(), "butler-app-first-run-smoke-"));
const dataDir = join(tempDir, "data");
const electronProfileDir = join(tempDir, "electron-profile");
const smokeHome = join(tempDir, "home");
mkdirSync(join(smokeHome, ".codex"), { recursive: true });
const firstRunSelector = "[data-test-class=\"first-run-setup\"]";
const forbiddenCopy = [
  "gateway",
  "Gateway",
  "persona",
  "Persona",
  "nickname",
  "Nickname",
  "이름",
  "닉네임",
  "페르소나",
  "관심사",
  "직업",
  "프로필",
];

const stubModelId = "smoke-local-model";
let stubModelServer: HttpServer | null = null;
let stubModelPort = 0;

let electronProcess: ChildProcess | null = null;
let appServerPort: number | null = null;
let cdp: CdpClient | null = null;
let ownedListenerPids = new Set<number>();
const output: string[] = [];

interface CdpClient {
  send<T = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T>;
  close(): void;
}

interface CdpTarget {
  type?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function freePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not allocate a local port.")));
        return;
      }
      server.close(() => resolvePort(address.port));
    });
  });
}

function listenerPids(port: number): number[] {
  if (process.platform === "win32") return [];
  const result = spawnSync("lsof", [`-tiTCP:${port}`, "-sTCP:LISTEN"], {
    encoding: "utf8",
  });
  return result.stdout
    .split(/\s+/u)
    .filter(Boolean)
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0);
}

function assertPortAvailable(port: number): void {
  const pids = listenerPids(port);
  if (pids.length > 0) {
    throw new Error(
      `Refusing to use port ${port}; already listening pid(s): ${pids.join(", ")}.`,
    );
  }
}

async function waitForPortClear(port: number, timeoutMs = 2500): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (listenerPids(port).length === 0) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  const pids = listenerPids(port);
  if (pids.length > 0) {
    throw new Error(
      `Test app-server port ${port} is still listening after cleanup: ${pids.join(", ")}.`,
    );
  }
}

async function cleanupOwnedPort(
  port: number,
  ownedPids: Set<number>,
): Promise<void> {
  if (process.platform === "win32" || ownedPids.size === 0) return;
  const pids = listenerPids(port).filter((pid) => ownedPids.has(pid));
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Best-effort cleanup for a smoke-test-owned managed server.
    }
  }
  await waitForPortClear(port);
}

function stopElectron(): void {
  if (!electronProcess || electronProcess.exitCode !== null) return;
  electronProcess.kill("SIGTERM");
  const child = electronProcess;
  setTimeout(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  }, 1500).unref();
}

async function connectToElectronPage(
  debugPort: number,
  appUrl: string,
): Promise<CdpClient> {
  const origin = new URL(appUrl).origin;
  const startedAt = Date.now();
  let lastTargets: CdpTarget[] = [];
  while (Date.now() - startedAt < 60_000) {
    if (electronProcess && electronProcess.exitCode !== null) {
      throw new Error(
        `Electron exited before CDP target appeared: ${electronProcess.exitCode}`,
      );
    }
    try {
      const targets = (await fetch(`http://127.0.0.1:${debugPort}/json/list`)
        .then((response) => response.json())) as CdpTarget[];
      lastTargets = targets;
      const target = targets.find((item) =>
        item.type === "page" &&
        (
          item.url?.startsWith(origin) ||
          item.url?.startsWith("app://butler/") ||
          item.url?.endsWith("/app-client/index.html") ||
          item.url?.endsWith("/dist/index.html")
        ) &&
        item.webSocketDebuggerUrl,
      );
      if (target?.webSocketDebuggerUrl) {
        const client = await connectCdp(target.webSocketDebuggerUrl);
        await client.send("Runtime.enable");
        await client.send("Page.enable");
        return client;
      }
    } catch {
      // Retry while Electron starts and exposes the renderer target.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  const seen = lastTargets.map((item) => `${item.type ?? "?"} ${item.url ?? ""}`);
  throw new Error(
    `Timed out waiting for Electron page target at ${origin}. Last targets: ${JSON.stringify(seen)}`,
  );
}

async function connectCdp(url: string): Promise<CdpClient> {
  const socket = new WebSocket(url);
  const pending = new Map<number, {
    reject: (error: Error) => void;
    resolve: (value: unknown) => void;
  }>();
  let nextId = 1;
  await new Promise<void>((resolveOpen, rejectOpen) => {
    const timeout = setTimeout(
      () => rejectOpen(new Error(`Timed out opening CDP socket: ${url}`)),
      10_000,
    );
    socket.addEventListener("open", () => {
      clearTimeout(timeout);
      resolveOpen();
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      rejectOpen(new Error(`Failed to open CDP socket: ${url}`));
    }, { once: true });
  });
  socket.addEventListener("message", (message) => {
    const payload = JSON.parse(String(message.data)) as {
      error?: { message?: string };
      id?: number;
      result?: unknown;
    };
    if (!payload.id) return;
    const entry = pending.get(payload.id);
    if (!entry) return;
    pending.delete(payload.id);
    if (payload.error) {
      entry.reject(new Error(payload.error.message ?? "CDP command failed."));
    } else {
      entry.resolve(payload.result);
    }
  });

  return {
    send<T = Record<string, unknown>>(
      method: string,
      params: Record<string, unknown> = {},
    ): Promise<T> {
      const id = nextId;
      nextId += 1;
      return new Promise<T>((resolve, reject) => {
        pending.set(id, {
          reject,
          resolve: (value) => resolve(value as T),
        });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      socket.close();
      for (const entry of pending.values()) {
        entry.reject(new Error("CDP socket closed."));
      }
      pending.clear();
    },
  };
}

async function waitForExpression(
  client: CdpClient,
  expression: string,
  label: string,
  timeoutMs = 20_000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await evaluateBoolean(client, expression)) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 120));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function evaluateBoolean(
  client: CdpClient,
  expression: string,
): Promise<boolean> {
  const result = await client.send<{
    exceptionDetails?: unknown;
    result?: { value?: unknown };
  }>("Runtime.evaluate", {
    awaitPromise: true,
    expression,
    returnByValue: true,
  });
  if (result.exceptionDetails) return false;
  return result.result?.value === true;
}

async function evaluateString(
  client: CdpClient,
  expression: string,
): Promise<string> {
  const result = await client.send<{
    exceptionDetails?: unknown;
    result?: { value?: unknown };
  }>("Runtime.evaluate", {
    awaitPromise: true,
    expression,
    returnByValue: true,
  });
  if (result.exceptionDetails) return "";
  return typeof result.result?.value === "string" ? result.result.value : "";
}

async function clickButton(client: CdpClient, label: string): Promise<void> {
  await waitForExpression(
    client,
    `Array.from(document.querySelectorAll("button")).some((button) => button.textContent?.trim() === ${JSON.stringify(label)})`,
    `button ${label}`,
  );
  const clicked = await evaluateBoolean(
    client,
    `(() => {
      const button = Array.from(document.querySelectorAll("button")).find((candidate) => candidate.textContent?.trim() === ${JSON.stringify(label)});
      if (!button) return false;
      button.click();
      return true;
    })()`,
  );
  assert(clicked, `button click failed: ${label}`);
}

async function fillInput(
  client: CdpClient,
  selector: string,
  value: string,
): Promise<void> {
  await waitForExpression(
    client,
    `document.querySelector(${JSON.stringify(selector)}) !== null`,
    `input ${selector}`,
  );
  const filled = await evaluateBoolean(
    client,
    `(() => {
      const input = document.querySelector(${JSON.stringify(selector)});
      if (!(input instanceof HTMLInputElement)) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new InputEvent("input", { bubbles: true, data: ${JSON.stringify(value)} }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return input.value === ${JSON.stringify(value)};
    })()`,
  );
  assert(filled, `input fill failed: ${selector}`);
}

async function waitForHeading(
  client: CdpClient,
  label: string,
  timeoutMs = 20_000,
): Promise<void> {
  await waitForExpression(
    client,
    `Array.from(document.querySelectorAll("h1,h2,h3")).some((heading) => heading.textContent?.trim() === ${JSON.stringify(label)})`,
    `heading ${label}`,
    timeoutMs,
  );
}

async function waitForText(
  client: CdpClient,
  label: string,
  timeoutMs = 20_000,
): Promise<void> {
  await waitForExpression(
    client,
    `document.body?.innerText?.includes(${JSON.stringify(label)}) === true`,
    `text ${label}`,
    timeoutMs,
  );
}

async function expectNoForbiddenCopy(
  client: CdpClient,
  allowed = new Set<string>(),
): Promise<void> {
  const text = await evaluateString(
    client,
    "document.body?.innerText?.trim() ?? ''",
  );
  for (const forbidden of forbiddenCopy) {
    if (allowed.has(forbidden)) continue;
    assert(!text.includes(forbidden), `unexpected first-run copy: ${forbidden}`);
  }
}

function stageNativeAgentInstallation(workDir: string): string {
  const prebuilt = process.env.BUTLER_FIRST_RUN_NATIVE_AGENT_EXECUTABLE?.trim();
  if (!prebuilt) {
    return join(prepareBundledAgentResource(root, workDir).resourceDir, "bin", "butler-agent");
  }
  assert(isAbsolute(prebuilt) && existsSync(prebuilt), `BUTLER_FIRST_RUN_NATIVE_AGENT_EXECUTABLE is not an absolute existing path: ${prebuilt}`);
  const installation = join(workDir, "bundled-agent");
  const resources = join(installation, "resources");
  mkdirSync(join(installation, "bin"), { recursive: true });
  cpSync(prebuilt, join(installation, "bin", "butler-agent"), { mode: 2 /* COPYFILE_FICLONE */ });
  cpSync(resolve(root, "packages", "butler-agent", "resources"), resources, { recursive: true });
  cpSync(uiRoot, join(resources, "app-client", "dist"), { recursive: true });
  // Same manifest prepare-native-agent.mjs writes; Electron checks its version.
  const cargo = readFileSync(resolve(root, "packages", "butler-agent", "rust", "crates", "butler-agent", "Cargo.toml"), "utf8");
  const version = cargo.match(/^version\s*=\s*"([^"]+)"/mu)?.[1];
  const appVersion = JSON.parse(readFileSync(join(electronAppRoot, "package.json"), "utf8")).version;
  assert(version && appVersion, "native Agent or App version is missing");
  writeFileSync(join(installation, "native-agent-manifest.json"), `${JSON.stringify({
    schema: "butler.native-agent-payload.v1", version, appVersion, platform: process.platform,
    architecture: process.arch, binary: "bin/butler-agent", resources: "resources",
  }, null, 2)}\n`);
  return join(installation, "bin", "butler-agent");
}

/** An OpenAI-compatible model list, for the first run's "Other" server path. */
async function startStubModelServer(): Promise<void> {
  stubModelServer = createHttpServer((request, response) => {
    if (request.method === "GET" && /\/models$/u.test(request.url ?? "")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: stubModelId, object: "model" }] }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end("{}");
  });
  await new Promise<void>((done) => stubModelServer!.listen(0, "127.0.0.1", done));
  const address = stubModelServer.address();
  stubModelPort = typeof address === "object" && address ? address.port : 0;
}

async function main(): Promise<void> {
  assert(
    existsSync(electronBin),
    "Electron binary is missing; run npm --prefix packages/butler-app/client/electron install first.",
  );
  assert(
    existsSync(join(uiRoot, "index.html")),
    "UI dist is missing; run npm --prefix packages/butler-app/client/ui run build first.",
  );

  await startStubModelServer();
  const serverPort = await freePort();
  appServerPort = serverPort;
  const debugPort = await freePort();
  assertPortAvailable(serverPort);
  assertPortAvailable(debugPort);
  // Unpackaged Electron resolves the native Agent from an absolute
  // BUTLER_NATIVE_AGENT_EXECUTABLE whose installation root (bin/..) carries
  // resources/ (bundled-native-agent.mjs). By default the smoke stages that
  // installation with the release producer (prepare-native-agent.mjs, static
  // ONNX Runtime; its cache lives under the Rust target dir). Set
  // BUTLER_FIRST_RUN_NATIVE_AGENT_EXECUTABLE to a prebuilt/locally built
  // butler-agent to skip the producer; it is staged with the repository
  // resources and the built UI the same way.
  const nativeAgentExecutable = stageNativeAgentInstallation(
    join(tempDir, "bundled-agent-resource"),
  );
  const nodePath = spawnSync("which", ["node"], { encoding: "utf8" }).stdout.trim();
  const smokePath = nodePath
    ? `${dirname(nodePath)}:/usr/bin:/bin:/usr/sbin:/sbin`
    : (process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BUTLER_BUN: process.execPath,
    BUTLER_DATA: dataDir,
    BUTLER_HOME: root,
    HOME: smokeHome,
    CODEX_HOME: join(smokeHome, ".codex"),
    BUTLER_APP_GATEWAY_PID_FILE: "off",
    BUTLER_NATIVE_AGENT_EXECUTABLE: nativeAgentExecutable,
    BUTLER_APP_SERVER_PORT: String(serverPort),
    LANG: "ko_KR.UTF-8",
    LC_ALL: "ko_KR.UTF-8",
    PATH: smokePath,
  };
  delete env.BUTLER_APP_SERVER_URL;
  delete env.BUTLER_APP_UI_URL;
  delete env.BUTLER_APP_DEV_ORIGIN;
  delete env.BUTLER_APP_SERVER_BRIDGE;
  delete env.BUTLER_APP_SERVER_DB;
  delete env.BUTLER_APP_BUTLER_HOME;
  delete env.BUTLER_APP_BUNDLED_AGENT_DIR;

  electronProcess = spawn(
    electronBin,
    [
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${electronProfileDir}`,
      "--lang=ko-KR",
      electronAppRoot,
    ],
    {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  electronProcess.stdout?.on("data", (chunk) => output.push(String(chunk)));
  electronProcess.stderr?.on("data", (chunk) => output.push(String(chunk)));

  cdp = await connectToElectronPage(debugPort, `http://127.0.0.1:${serverPort}/`);
  ownedListenerPids = new Set(listenerPids(serverPort));
  await waitForExpression(
    cdp,
    "typeof window.butlerApp === 'object' && window.butlerApp?.protocolVersion === 'butler.app.v1'",
    "sandbox preload app bridge",
  );
  await waitForExpression(
    cdp,
    `document.querySelector(${JSON.stringify(firstRunSelector)}) !== null`,
    "first-run setup root",
  );
  const setupDragRegion = await evaluateString(
    cdp,
    "getComputedStyle(document.querySelector('[data-test-class=\"setup-wizard-drag-lane\"]')).getPropertyValue(\"-webkit-app-region\")",
  );
  assert(
    setupDragRegion === "drag",
    `first-run drag lane should be draggable, got ${setupDragRegion}`,
  );

  // Welcome: language comes from the system, consent is one screen, and the
  // agent prepares in the background (no language, safety or install screen).
  await waitForHeading(cdp, "반갑습니다");
  await expectNoForbiddenCopy(cdp);
  const selectedLanguage = await evaluateString(
    cdp,
    "document.querySelector('#first-run-language')?.value ?? ''",
  );
  assert(selectedLanguage === "ko", "system language did not preselect Korean");
  for (const retired of ["언어 선택", "안전고지", "Butler Agent를 준비합니다", "모델 설정"]) {
    assert(!(await evaluateBoolean(cdp, `document.body.innerText.includes(${JSON.stringify(retired)})`)), `retired first-run screen visible: ${retired}`);
  }

  await cdp.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: "dark" }],
  });
  await waitForExpression(
    cdp,
    "document.body.classList.contains('theme-dark')",
    "first-run dark theme class",
  );
  const firstRunDarkText = await evaluateString(
    cdp,
    `getComputedStyle(document.querySelector(${JSON.stringify(firstRunSelector)})).color`,
  );
  const darkTextChannels = firstRunDarkText.match(/\d+(?:\.\d+)?/gu)?.slice(0, 3).map(Number) ?? [];
  assert(
    darkTextChannels.length === 3 && darkTextChannels.every((channel) => channel > 180),
    `first-run text should use dark-theme foreground, got ${firstRunDarkText}`,
  );
  await cdp.send("Emulation.setEmulatedMedia", { features: [] });

  await clickButton(cdp, "시작하기");
  await waitForHeading(cdp, "시작하기 전에 확인해 주세요");
  await clickButton(cdp, "동의하지 않음");
  await waitForHeading(cdp, "반갑습니다");
  assert(await evaluateBoolean(cdp, "document.activeElement?.id === 'first-run-start'"), "Decline focuses Start");
  await clickButton(cdp, "시작하기");
  await clickButton(cdp, "동의하고 시작");
  await waitForHeading(cdp, "어떤 AI와 일할까요?");
  await expectNoForbiddenCopy(cdp);
  const topCards = await evaluateString(
    cdp,
    "Array.from(document.querySelectorAll('[data-test-class=\"first-run-top-cards\"] [data-card-id]')).map((card) => card.getAttribute('data-card-id')).join(',')",
  );
  assert(topCards.startsWith("chatgpt,claude,gemini"), `top provider cards: ${topCards}`);
  for (const jargon of ["OAuth", "credential", "provider", "endpoint"]) {
    assert(!(await evaluateBoolean(cdp, `document.body.innerText.includes(${JSON.stringify(jargon)})`)), `jargon in the AI list: ${jargon}`);
  }

  // Other (OpenAI-compatible) against a stub server: the one path that needs
  // no network account, so the smoke stays offline.
  await clickButton(cdp, "다른 서비스 8개");
  const otherClicked = await evaluateBoolean(
    cdp,
    "(() => { const tile = document.querySelector('[data-card-id=\"other\"]'); tile?.click(); return Boolean(tile); })()",
  );
  assert(otherClicked, "Other (OpenAI-compatible) tile is missing");
  await waitForHeading(cdp, "OpenAI 호환 서버");
  await fillInput(cdp, "#first-run-server-url", `http://127.0.0.1:${stubModelPort}/v1`);
  await clickButton(cdp, "연결");
  await waitForText(cdp, stubModelId);
  await clickButton(cdp, "이 모델로 시작");
  await waitForExpression(cdp, "document.querySelector('#first-run-reply-language')?.disabled === false", "reply language choice");
  await clickButton(cdp, "시작");
  await waitForExpression(
    cdp,
    `document.querySelector(${JSON.stringify(firstRunSelector)}) === null && document.querySelector('[data-test-class="workspace"]') !== null`,
    "workspace after first-run completion",
  );

  console.log(JSON.stringify({
    ok: true,
    service: "butler-app-first-run-setup-smoke",
    checks: [
      "sandbox-preload-app-bridge",
      "electron-first-run-visible",
      "first-run-drag-lane",
      "system-language-ko-preselected",
      "first-run-honors-dark-theme",
      "welcome-then-pick-an-ai",
      "no-language-safety-install-screens",
      "no-normal-gateway-selector",
      "no-personal-onboarding-copy",
      "top-provider-cards",
      "no-jargon-in-ai-list",
      "openai-compatible-server-models",
      "workspace-gate-opens-after-connection",
    ],
    appServerUrl: `http://127.0.0.1:${serverPort}/`,
  }));
}

try {
  await main();
} catch (error) {
  const details = output.join("").trim();
  const message = error instanceof Error ? error.message : String(error);
  throw new Error(details ? `${message}\n${details}` : message, { cause: error });
} finally {
  (cdp as CdpClient | null)?.close();
  stopElectron();
  (stubModelServer as HttpServer | null)?.close();
  if (electronProcess) {
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  if (appServerPort !== null) await cleanupOwnedPort(appServerPort, ownedListenerPids);
  rmSync(tempDir, { recursive: true, force: true });
}
