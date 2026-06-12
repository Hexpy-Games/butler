import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { prepareBundledAgentResource } from "../../packages/butler-app/scripts/release/package-app-release.ts";

const root = process.cwd();
const uiRoot = resolve(root, "packages", "butler-app", "client", "ui", "dist");
const electronRoot = resolve(
  root,
  "packages",
  "butler-app",
  "client",
  "electron",
);
const electronMain = resolve(electronRoot, "main.mjs");
const macSignScript = resolve(electronRoot, "scripts", "adhoc-sign-mac.mjs");
const macNormalizeScript = resolve(electronRoot, "scripts", "normalize-mac-bundle.mjs");
const butlerIcon = resolve(electronRoot, "assets", "butler.icns");
const packagerBin = resolve(
  electronRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "electron-packager.cmd" : "electron-packager",
);
const tempDir = mkdtempSync(join(tmpdir(), "butler-app-package-smoke-"));
const packagedOut = join(tempDir, "packaged");
const cleanDataRoot = join(tempDir, "clean-data");
const standaloneHome = join(tempDir, "standalone-agent-home");
const hostToolBlockBin = join(tempDir, "host-tool-block-bin");
const hostToolBlockLog = join(tempDir, "host-tool-block-log.txt");
const packagedArch = process.arch === "arm64" ? "arm64" : "x64";
const blockedHostTools = [
  "bun",
  "node",
  "npm",
  "npx",
  "git",
  "curl",
  "wget",
  "unzip",
  "tar",
  "brew",
  "apt",
  "apt-get",
  "dnf",
  "yum",
  "pacman",
];

interface CdpTarget {
  type?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

interface CdpClient {
  send<T = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T>;
  close(): void;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writeHostToolBlockers(): void {
  mkdirSync(hostToolBlockBin, { recursive: true });
  for (const tool of blockedHostTools) {
    const path = join(hostToolBlockBin, tool);
    writeFileSync(
      path,
      [
        "#!/bin/sh",
        `printf '%s\\n' '${tool}' >> "$BUTLER_HOST_TOOL_BLOCK_LOG"`,
        "exit 127",
        "",
      ].join("\n"),
      "utf8",
    );
    chmodSync(path, 0o755);
  }
}

function minimalPackagedAppEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.BUTLER_APP_BUNDLED_AGENT_DIR;
  delete env.BUTLER_APP_MANAGED_RUNTIME_HOME;
  delete env.BUTLER_APP_MANAGED_RUNTIME_POINTER;
  delete env.BUTLER_APP_BUTLER_HOME;
  delete env.BUTLER_BUN;
  delete env.BUTLER_CLI;
  delete env.npm_execpath;
  delete env.npm_node_execpath;
  delete env.npm_config_user_agent;
  return {
    ...env,
    ...overrides,
    PATH: hostToolBlockBin,
    BUTLER_HOST_TOOL_BLOCK_LOG: hostToolBlockLog,
  };
}

function assertNoHostToolCalls(): void {
  if (!existsSync(hostToolBlockLog)) return;
  const calls = readFileSync(hostToolBlockLog, "utf8").trim();
  assert(!calls, `packaged App called host tools during minimal PATH first launch: ${calls}`);
}

function plistValue(appBundle: string, key: string): string {
  const result = spawnSync("/usr/libexec/PlistBuddy", [
    "-c",
    `Print :${key}`,
    join(appBundle, "Contents", "Info.plist"),
  ], {
    cwd: root,
    encoding: "utf8",
  });
  assert(result.status === 0, `failed to read ${key}: ${result.stderr}`);
  return result.stdout.trim();
}

async function readJson(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => null);
  assert(
    response.ok,
    `request failed: ${response.status} ${JSON.stringify(body)}`,
  );
  assert(
    body?.protocol_version === "butler.app.v1",
    "invalid app protocol envelope",
  );
  return body.data;
}

async function freePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("could not allocate local port")));
        return;
      }
      server.close(() => resolvePort(address.port));
    });
  });
}

async function waitForLocalAuth(path: string, timeoutMs = 20_000): Promise<string> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (typeof parsed?.token === "string" && parsed.token.length >= 32) {
        return parsed.token;
      }
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  throw new Error(`timed out waiting for App local auth file: ${path}`);
}

async function waitForBundledHealth(url: string, authPath: string): Promise<string> {
  const startedAt = Date.now();
  let token = "";
  while (Date.now() - startedAt < 30_000) {
    if (!token && existsSync(authPath)) {
      token = await waitForLocalAuth(authPath);
    }
    if (token) {
      try {
        const response = await fetch(url, {
          headers: { authorization: `Bearer ${token}` },
        });
        const body = await response.json().catch(() => null);
        if (
          response.ok &&
          body?.protocol_version === "butler.app.v1" &&
          body?.data?.ok === true
        ) {
          return token;
        }
      } catch {
        // Retry while Electron prepares the bundled Agent runtime.
      }
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  throw new Error(`timed out waiting for bundled Agent health: ${url}`);
}

async function waitForStandaloneHealth(url: string, child: ReturnType<typeof spawn>): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 30_000) {
    if (child.exitCode !== null) {
      throw new Error(`standalone Agent exited before health check: ${child.exitCode}`);
    }
    try {
      const response = await fetch(url);
      const body = await response.json().catch(() => null);
      if (
        response.ok &&
        body?.protocol_version === "butler.app.v1" &&
        body?.data?.ok === true
      ) {
        return;
      }
    } catch {
      // Retry while the standalone gateway starts.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  throw new Error(`timed out waiting for standalone Agent health: ${url}`);
}

async function waitForJsonFile(path: string, timeoutMs = 10_000): Promise<any> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, "utf8"));
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  throw new Error(`timed out waiting for JSON file: ${path}`);
}

async function connectToElectronPage(port: number, appUrl: string, appProcess: ReturnType<typeof spawn>): Promise<CdpClient> {
  const origin = new URL(appUrl).origin;
  const startedAt = Date.now();
  while (Date.now() - startedAt < 30_000) {
    if (appProcess.exitCode !== null) {
      throw new Error(`packaged app exited before renderer target appeared: ${appProcess.exitCode}`);
    }
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`)
        .then((response) => response.json()) as CdpTarget[];
      const target = targets.find((item) =>
        item.type === "page" &&
        item.url?.startsWith(origin) &&
        item.webSocketDebuggerUrl,
      );
      if (target?.webSocketDebuggerUrl) {
        const client = await connectCdp(target.webSocketDebuggerUrl);
        await client.send("Runtime.enable");
        await client.send("Page.enable");
        return client;
      }
    } catch {
      // Retry while Electron starts and publishes the renderer target.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  throw new Error(`timed out waiting for packaged app renderer target at ${origin}`);
}

async function connectCdp(url: string): Promise<CdpClient> {
  const socket = new WebSocket(url);
  const pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  let nextId = 1;

  await new Promise<void>((resolveOpen, rejectOpen) => {
    const timeout = setTimeout(
      () => rejectOpen(new Error(`timed out opening CDP socket: ${url}`)),
      10_000,
    );
    socket.addEventListener("open", () => {
      clearTimeout(timeout);
      resolveOpen();
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      rejectOpen(new Error(`failed to open CDP socket: ${url}`));
    }, { once: true });
  });

  socket.addEventListener("message", (message) => {
    const payload = JSON.parse(String(message.data)) as {
      id?: number;
      result?: unknown;
      error?: { message?: string };
    };
    if (!payload.id) return;
    const entry = pending.get(payload.id);
    if (!entry) return;
    pending.delete(payload.id);
    if (payload.error) entry.reject(new Error(payload.error.message ?? "CDP command failed"));
    else entry.resolve(payload.result);
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
          resolve: (value) => resolve(value as T),
          reject,
        });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      socket.close();
      for (const entry of pending.values()) entry.reject(new Error("CDP socket closed"));
      pending.clear();
    },
  };
}

async function evaluateRenderer<T>(client: CdpClient, expression: string): Promise<T> {
  const startedAt = Date.now();
  let lastError = "";
  while (Date.now() - startedAt < 30_000) {
    try {
      const result = await client.send<{
        result?: { value?: T };
        exceptionDetails?: unknown;
      }>("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      assert(!result.exceptionDetails, `renderer evaluation failed: ${JSON.stringify(result.exceptionDetails)}`);
      return result.result?.value as T;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (!lastError.includes("Execution context was destroyed")) throw error;
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
  }
  throw new Error(`renderer evaluation did not stabilize: ${lastError}`);
}

async function packagedRendererCompletesFirstRun(client: CdpClient): Promise<void> {
  const result = await evaluateRenderer<{ ok: boolean; step: string }>(client, `new Promise((resolve) => {
    const clickButton = (labels) => {
      const buttons = Array.from(document.querySelectorAll("button"));
      const button = buttons.find((item) => labels.includes((item.textContent || "").trim()));
      if (!button) return false;
      button.click();
      return true;
    };
    const waitFor = (predicate, timeoutMs = 30000) => new Promise((resolveWait, rejectWait) => {
      const startedAt = Date.now();
      const tick = () => {
        if (predicate()) {
          resolveWait(true);
          return;
        }
        if (Date.now() - startedAt > timeoutMs) {
          rejectWait(new Error("timed out"));
          return;
        }
        setTimeout(tick, 100);
      };
      tick();
    });
    (async () => {
      await waitFor(() => document.querySelector('[data-test-class="first-run-setup"]'));
      if (!clickButton(["계속", "Continue"])) throw new Error("language continue button missing");
      await waitFor(() => clickButton(["동의", "Accept"]));
      await waitFor(() => clickButton(["나중에 설정", "Set up later"]));
      await waitFor(() => document.querySelector('[data-test-class="workspace"]'));
      resolve({ ok: true, step: "workspace" });
    })().catch((error) => resolve({ ok: false, step: String(error && error.message || error) }));
  })`);
  assert(result?.ok === true, `packaged app did not enter workspace after first-run setup: ${result?.step}`);
}

assert(
  existsSync(join(uiRoot, "index.html")),
  "Butler app UI dist is missing; run npm --prefix packages/butler-app/client/ui run build first",
);
assert(existsSync(electronMain), "Electron entrypoint is missing");
assert(
  existsSync(packagerBin),
  "Electron packager is missing; run npm --prefix packages/butler-app/client/electron install first",
);
writeHostToolBlockers();

const bundledAgent = prepareBundledAgentResource(root, tempDir);

try {
  mkdirSync(packagedOut, { recursive: true });
  const packagerIcon = join(packagedOut, "butler-smoke-icon.icns");
  copyFileSync(butlerIcon, packagerIcon);
  const packageResult = spawnSync(
    packagerBin,
    [
      electronRoot,
      "Butler",
      "--platform=darwin",
      `--arch=${packagedArch}`,
      "--overwrite",
      `--out=${packagedOut}`,
      `--icon=${packagerIcon}`,
      `--extra-resource=${bundledAgent.resourceDir}`,
      "--ignore=^/dist($|/)",
      "--quiet",
    ],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
  assert(
    packageResult.status === 0,
    `electron package failed: ${packageResult.stderr || packageResult.stdout}`,
  );

  const packageDir = readdirSync(packagedOut).find(
    (entry) => entry === `Butler-darwin-${packagedArch}`,
  );
  assert(packageDir, "packaged app directory was not created");
  const executable = join(
    packagedOut,
    packageDir,
    "Butler.app",
    "Contents",
    "MacOS",
    "Butler",
  );
  const appBundle = join(packagedOut, packageDir, "Butler.app");
  const rawPackagedIcon = join(
    packagedOut,
    packageDir,
    "Butler.app",
    "Contents",
    "Resources",
    "electron.icns",
  );
  const normalizedPackagedIcon = join(
    packagedOut,
    packageDir,
    "Butler.app",
    "Contents",
    "Resources",
    "butler.icns",
  );
  assert(existsSync(executable), "packaged app executable was not created");
  assert(
    existsSync(rawPackagedIcon),
    "packaged app mac icon resource was not created",
  );
  assert(
    sha256(rawPackagedIcon) === sha256(butlerIcon),
    "packaged app mac icon resource does not match Butler icon",
  );

  if (process.platform === "darwin") {
    const normalizeResult = spawnSync("node", [macNormalizeScript, appBundle], {
      cwd: root,
      encoding: "utf8",
    });
    assert(
      normalizeResult.status === 0,
      `mac bundle normalization failed: ${normalizeResult.stderr || normalizeResult.stdout}`,
    );
    assert(
      existsSync(normalizedPackagedIcon),
      "normalized packaged app mac icon resource was not created",
    );
    assert(
      sha256(normalizedPackagedIcon) === sha256(butlerIcon),
      "normalized packaged app mac icon resource does not match Butler icon",
    );
    assert(
      plistValue(appBundle, "CFBundleIconFile") === "butler.icns",
      "packaged app icon plist does not point at butler.icns",
    );
    assert(
      plistValue(appBundle, "CFBundleIconName") === "butler",
      "packaged app icon name is not Butler",
    );
    assert(
      plistValue(appBundle, "CFBundleIdentifier") === "com.hexpy.butler",
      "packaged app bundle id is not Butler",
    );
    const signResult = spawnSync("node", [macSignScript, appBundle], {
      cwd: root,
      encoding: "utf8",
    });
    assert(
      signResult.status === 0,
      `mac ad-hoc signing failed: ${signResult.stderr || signResult.stdout}`,
    );
  }

  if (process.platform === "darwin") {
    const serverPort = await freePort();
    const serverUrl = `http://127.0.0.1:${serverPort}/`;
    const authPath = join(cleanDataRoot, "app", "runtime", "auth", "local-agent-auth.json");
    const standalonePort = await freePort();
    const debugPort = await freePort();
    const standalone = spawn(process.execPath, [join(root, "bin", "butler.js"), "gateway", "app"], {
      cwd: root,
      env: {
        ...process.env,
        BUTLER_BUN: process.execPath,
        BUTLER_HOME: root,
        BUTLER_DATA: standaloneHome,
        BUTLER_APP_BUNDLED_SUPERVISOR: "1",
        BUTLER_APP_SERVER_PORT: String(standalonePort),
        BUTLER_APP_SERVER_BRIDGE: "off",
        BUTLER_APP_GATEWAY_PID_FILE: "off",
      },
      stdio: "ignore",
    });
    const appProcess = spawn(executable, [
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${join(tempDir, "packaged-electron-profile")}`,
    ], {
      env: minimalPackagedAppEnv({
        BUTLER_HOME: standaloneHome,
        BUTLER_DATA: cleanDataRoot,
        BUTLER_APP_SERVER_PORT: String(serverPort),
        BUTLER_APP_SERVER_BRIDGE: "off",
      }),
      stdio: "ignore",
    });
    let cdp: CdpClient | null = null;
    try {
      await waitForStandaloneHealth(`http://127.0.0.1:${standalonePort}/health`, standalone);
      const token = await waitForBundledHealth(`${serverUrl}health`, authPath);
      cdp = await connectToElectronPage(debugPort, serverUrl, appProcess);
      assert(
        appProcess.exitCode === null,
        "packaged app exited before smoke validation completed",
      );
      assert(
        standalone.exitCode === null,
        "standalone Agent exited during packaged App smoke",
      );
      const unauthorized = await fetch(`${serverUrl}health`);
      assert(
        unauthorized.status === 401,
        "bundled Agent health should require App local auth",
      );
      const settings = await readJson(`${serverUrl}settings`, {
        headers: { authorization: `Bearer ${token}` },
      });
      assert(
        settings.gateway_profile === "electron",
        "packaged bundled Agent did not enforce electron gateway profile",
      );
      const pointerPath = join(cleanDataRoot, "app", "runtime", "agent", "current.json");
      const pointer = await waitForJsonFile(pointerPath);
      const runtimeMetadata = await waitForJsonFile(
        join(cleanDataRoot, pointer.runtime_home, "runtime.json"),
      );
      assert(
        pointer.bundled_agent_version === bundledAgent.version,
        "packaged app did not activate the bundled Agent version",
      );
      assert(
        String(runtimeMetadata.source_resource_path).includes(
          join("Contents", "Resources", "bundled-agent"),
        ),
        "packaged app did not activate bundled Agent resources from the packaged app",
      );
      assert(
        !existsSync(join(standaloneHome, "app", "runtime", "agent", "current.json")),
        "packaged app activated bundled runtime inside standalone Agent home",
      );
      assert(
        !existsSync(join(cleanDataRoot, "state", "gateways", "app.pid")),
        "packaged bundled Agent wrote a standalone gateway pid file",
      );
      await packagedRendererCompletesFirstRun(cdp);
      assertNoHostToolCalls();
    } finally {
      cdp?.close();
      appProcess.kill("SIGTERM");
      standalone.kill("SIGTERM");
    }
  }

  console.log(
    JSON.stringify({
      ok: true,
      service: "butler-app-package-smoke",
      checks: [
        "packaged-app-launched",
        "bundled-agent-resource-present",
        "clean-data-home",
        "local-auth-required",
        "electron-gateway-profile",
        "bundled-agent-version-activated",
        "first-run-completed",
        "workspace-entered",
        "minimal-path-first-launch",
        "host-tool-blockers-unused",
        "packaged-resource-source",
        "standalone-home-unchanged",
      ],
      uiRoot: "packages/butler-app/client/ui/dist",
      packagedApp: `Butler-darwin-${packagedArch}/Butler.app`,
      bundledAgentArtifact: bundledAgent.artifactName,
    }),
  );
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
