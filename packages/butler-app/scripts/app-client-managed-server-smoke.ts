import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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
const electronAppRoot = resolve(root, "packages", "butler-app", "client", "electron");
const uiRoot = resolve(root, "packages", "butler-app", "client", "ui", "dist");
const tempDir = mkdtempSync(join(tmpdir(), "butler-app-client-managed-server-"));
let electronProcess: ChildProcess | null = null;

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

async function waitForHealth(url: string, timeoutMs = 20_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const child = electronProcess;
    if (child && child.exitCode !== null) {
      throw new Error(`Electron exited before app-server became healthy: ${child.exitCode}`);
    }
    try {
      const response = await fetch(url);
      const body = await response.json().catch(() => null);
      if (response.ok && body?.protocol_version === "butler.app.v1" && body?.data?.ok === true) return;
    } catch {
      // Retry while Electron starts and spawns the managed app-server.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function stopElectron(): void {
  if (!electronProcess || electronProcess.exitCode !== null) return;
  electronProcess.kill("SIGTERM");
  const child = electronProcess;
  setTimeout(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  }, 1500).unref();
}

function cleanupPort(port: number): void {
  if (process.platform === "win32") return;
  const result = spawnSync("lsof", [`-tiTCP:${port}`, "-sTCP:LISTEN"], {
    encoding: "utf8",
  });
  for (const pid of result.stdout.split(/\s+/u).filter(Boolean)) {
    try {
      process.kill(Number(pid), "SIGTERM");
    } catch {
      // Best-effort cleanup for a smoke-test-owned managed server.
    }
  }
}

assert(existsSync(electronBin), "Electron binary is missing; run npm --prefix packages/butler-app/client/electron install first");
assert(existsSync(join(uiRoot, "index.html")), "UI dist is missing; run npm --prefix packages/butler-app/client/ui run build first");

const serverPort = await freePort();
const healthUrl = `http://127.0.0.1:${serverPort}/health`;
const output: string[] = [];
const electronEnv: NodeJS.ProcessEnv = {
  ...process.env,
  BUTLER_APP_SERVER_PORT: String(serverPort),
  BUTLER_APP_SERVER_BRIDGE: "off",
  BUTLER_DATA: tempDir,
};
delete electronEnv.BUTLER_APP_SERVER_URL;
delete electronEnv.BUTLER_APP_UI_URL;
delete electronEnv.BUTLER_APP_DEV_ORIGIN;

try {
  electronProcess = spawn(electronBin, [electronAppRoot], {
    cwd: root,
    env: electronEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  electronProcess.stdout?.on("data", (chunk) => output.push(String(chunk)));
  electronProcess.stderr?.on("data", (chunk) => output.push(String(chunk)));

  await waitForHealth(healthUrl);

  console.log(JSON.stringify({
    ok: true,
    service: "butler-app-client-managed-server-smoke",
    checks: ["electron-started", "managed-app-server-healthy", "single-slash-health-url"],
    appServerUrl: `http://127.0.0.1:${serverPort}/`,
  }));
} catch (error) {
  const details = output.join("").trim();
  const message = error instanceof Error ? error.message : String(error);
  throw new Error(details ? `${message}\n${details}` : message, { cause: error });
} finally {
  stopElectron();
  cleanupPort(serverPort);
  rmSync(tempDir, { recursive: true, force: true });
}
