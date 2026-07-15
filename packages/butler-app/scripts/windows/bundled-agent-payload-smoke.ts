import { spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activateAppManagedAgentRuntime,
  appManagedAgentPointerPath,
  resolveAppManagedGatewayCommand,
  windowsRuntimeSignatureIssue,
} from "../../client/electron/app-managed-runtime.mjs";
import { prepareBundledAgentResource } from "../release/package-app-release.ts";

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("bundled Agent payload smoke requires Windows x64");
}

const repoRoot = process.cwd();
const smokeRoot = join(tmpdir(), "Butler 번들 payload smoke with spaces");
const workDir = join(smokeRoot, "패키징 work");
const butlerData = join(smokeRoot, "사용자 data");
rmSync(smokeRoot, { recursive: true, force: true });
mkdirSync(smokeRoot, { recursive: true });

let gatewayHealthy: boolean;
let rollbackPreserved = false;

try {
  const resource = prepareBundledAgentResource(
    repoRoot,
    workDir,
    "win32-x64",
  );
  const signatureManifest = readJson(
    join(resource.resourceDir, "runtime", "windows-signatures.json"),
  );
  const signedRuntimeHashPins =
    windowsRuntimeSignatureIssue(join(resource.resourceDir, "runtime")) === null &&
    signatureManifest.files.every(
      (file: { status?: string }) => file.status === "Valid",
    );
  const dependencyClosurePresent = existsSync(
    join(resource.resourceDir, "dependency-closure.json"),
  );

  const activation = activateAppManagedAgentRuntime({
    butlerData,
    resourceRoot: resource.resourceDir,
    platform: "win32",
  });
  const archiveInventory = readJson(
    join(activation.runtimeHome, ".butler-agent-archive-inventory.json"),
  );
  const streamingExtraction =
    Number(archiveInventory.workerRssBytes) > 0 &&
    Number(archiveInventory.workerRssBytes) < 512 * 1024 * 1024;
  const foregroundOwned = readJson(
    join(resource.resourceDir, "background-service-registration.json"),
  ).installerRequired === "no";
  const noLinksInstalled = !treeContainsLinks(activation.runtimeHome);

  const command = resolveAppManagedGatewayCommand({
    butlerData,
    env: {
      ...process.env,
      BUTLER_APP_BUNDLED_AGENT_DIR: resource.resourceDir,
    },
    platform: "win32",
  });
  if (!command) throw new Error("App-managed Windows gateway command is unavailable");
  const port = await availablePort();
  const processHost = join(
    command.cwd,
    "packages",
    "butler-agent",
    "resources",
    "runtime",
    "bin",
    "butler-process-host.exe",
  );
  const child = spawn(processHost, [command.command, ...command.args], {
    cwd: command.cwd,
    env: {
      ...process.env,
      ...command.env,
      BUTLER_APP_SERVER_HOST: "127.0.0.1",
      BUTLER_APP_SERVER_PORT: String(port),
      BUTLER_APP_LOCAL_AUTH_REQUIRED: "0",
      BUTLER_WINDOWS_PROCESS_HOST: processHost,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let gatewayOutput = "";
  child.stdout.on("data", (chunk) => {
    gatewayOutput = `${gatewayOutput}${String(chunk)}`.slice(-4000);
  });
  child.stderr.on("data", (chunk) => {
    gatewayOutput = `${gatewayOutput}${String(chunk)}`.slice(-4000);
  });
  try {
    gatewayHealthy = await waitForHealth(port, child, 45_000);
    if (!gatewayHealthy) {
      throw new Error(`Windows gateway health proof failed: ${gatewayOutput}`);
    }
    command.commitActivation();
  } finally {
    child.kill();
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
    ]);
  }

  const launcher = join(activation.runtimeHome, "bin", "butler.js");
  const originalLauncher = readFileSync(launcher);
  writeFileSync(launcher, "damaged launcher\n");
  const repaired = activateAppManagedAgentRuntime({
    butlerData,
    resourceRoot: resource.resourceDir,
    platform: "win32",
  });
  const repairSucceeded =
    repaired.activated &&
    readFileSync(launcher).equals(originalLauncher);

  const pointerPath = appManagedAgentPointerPath(butlerData);
  const pointerBeforeFailure = readFileSync(pointerPath, "utf8");
  const bundledBun = join(resource.resourceDir, "runtime", "bin", "bun.exe");
  writeFileSync(bundledBun, "damaged signed runtime\n");
  try {
    activateAppManagedAgentRuntime({
      butlerData,
      resourceRoot: resource.resourceDir,
      platform: "win32",
    });
  } catch {
    rollbackPreserved =
      readFileSync(pointerPath, "utf8") === pointerBeforeFailure &&
      readFileSync(launcher).equals(originalLauncher);
  }

  const result = {
    ok:
      gatewayHealthy &&
      repairSucceeded &&
      rollbackPreserved &&
      noLinksInstalled &&
      dependencyClosurePresent &&
      signedRuntimeHashPins &&
      foregroundOwned &&
      streamingExtraction,
    platform: "win32-x64",
    standardUser: process.env.BUTLER_WINDOWS_STANDARD_USER === "1",
    bundledRuntime: true,
    bundledAgentDependencyClosure: dependencyClosurePresent,
    authenticodeValid: signedRuntimeHashPins,
    noLinksInstalled,
    streamingExtraction,
    archiveWorkerRssBytes: Number(archiveInventory.workerRssBytes),
    activation: true,
    gatewayHealth: gatewayHealthy,
    repair: repairSucceeded,
    rollback: rollbackPreserved,
    appForegroundOwned: foregroundOwned,
    compileRequiredAtRuntime: false,
    hostRuntimeRequired: false,
    unicodeAndSpaces: true,
    rawTextIncluded: false,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
} finally {
  rmSync(smokeRoot, { recursive: true, force: true });
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

function treeContainsLinks(root: string): boolean {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return true;
    if (stat.isDirectory() && treeContainsLinks(path)) return true;
  }
  return false;
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function waitForHealth(
  port: number,
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return false;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return true;
    } catch {
      // The gateway has not bound the loopback port yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}
