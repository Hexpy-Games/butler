import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

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
  while (Date.now() - startedAt < 60_000) {
    if (electronProcess && electronProcess.exitCode !== null) {
      throw new Error(
        `Electron exited before CDP target appeared: ${electronProcess.exitCode}`,
      );
    }
    try {
      const targets = (await fetch(`http://127.0.0.1:${debugPort}/json/list`)
        .then((response) => response.json())) as CdpTarget[];
      const target = targets.find((item) =>
        item.type === "page" &&
        (
          item.url?.startsWith(origin) ||
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
  throw new Error(`Timed out waiting for Electron page target at ${origin}.`);
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

async function expectNoForbiddenCopy(client: CdpClient): Promise<void> {
  const text = await evaluateString(
    client,
    "document.body?.innerText?.trim() ?? ''",
  );
  for (const forbidden of forbiddenCopy) {
    assert(!text.includes(forbidden), `unexpected first-run copy: ${forbidden}`);
  }
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

  const serverPort = await freePort();
  appServerPort = serverPort;
  const debugPort = await freePort();
  assertPortAvailable(serverPort);
  assertPortAvailable(debugPort);
  const nodePath = spawnSync("which", ["node"], { encoding: "utf8" }).stdout.trim();
  const smokePath = nodePath
    ? `${dirname(nodePath)}:/usr/bin:/bin:/usr/sbin:/sbin`
    : (process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BUTLER_BUN: process.execPath,
    BUTLER_DATA: dataDir,
    BUTLER_HOME: root,
    BUTLER_APP_GATEWAY_PID_FILE: "off",
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
    `document.querySelector(${JSON.stringify(firstRunSelector)}) !== null`,
    "first-run setup root",
  );

  await waitForHeading(cdp, "언어 선택");
  await expectNoForbiddenCopy(cdp);
  const selectedLanguageLabel = await evaluateString(
    cdp,
    "document.querySelector('[role=\"combobox\"][aria-label=\"언어 선택\"]')?.textContent?.trim() ?? \"\"",
  );
  assert(
    selectedLanguageLabel.includes("한국어"),
    "system language did not preselect Korean",
  );

  await clickButton(cdp, "계속");
  await waitForHeading(cdp, "안전고지");
  await expectNoForbiddenCopy(cdp);

  await clickButton(cdp, "동의");
  await waitForHeading(cdp, "Butler Agent를 준비합니다");
  await expectNoForbiddenCopy(cdp);
  assert(
    !(await evaluateBoolean(
      cdp,
      `Array.from(document.querySelectorAll(${JSON.stringify("button")})).some((button) => button.textContent?.trim() === ${JSON.stringify("기존 Agent 연결")})`,
    )),
    "existing-Agent action is visible in the normal setup path",
  );
  await waitForText(cdp, "준비 완료");

  await waitForHeading(cdp, "모델 설정");
  await expectNoForbiddenCopy(cdp);

  console.log(JSON.stringify({
    ok: true,
    service: "butler-app-first-run-setup-smoke",
    checks: [
      "electron-first-run-visible",
      "system-language-ko-preselected",
      "language-safety-install-model-order",
      "agent-progress-title",
      "no-normal-gateway-selector",
      "no-personal-onboarding-copy",
      "model-setup-after-readiness",
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
  if (electronProcess) {
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  if (appServerPort !== null) await cleanupOwnedPort(appServerPort, ownedListenerPids);
  rmSync(tempDir, { recursive: true, force: true });
}
