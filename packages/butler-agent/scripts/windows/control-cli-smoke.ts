import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchBackgroundWorker } from "../../src/agent/tool-support/background-worker-dispatch.ts";
import {
  backgroundCommandControlPaths,
  registeredBackgroundCommandCount,
  startRegisteredBackgroundCommand,
} from "../../src/runtime/command/background-command-registry.ts";
import { executeLegacyCommandCompatibility } from "../../src/runtime/command/legacy-command-compat.ts";
import { createPlatformCommandExecutor } from "../../src/runtime/command/platform-command-executor.ts";

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("Windows control and CLI smoke requires Windows x64");
}

const root = join(tmpdir(), "Butler G2 control 한글 with spaces");
const butlerHome = join(root, "payload source");
const butlerData = join(root, "user data");
const projectPath = join(root, "project source");
const taskId = "windows-control-worker";
const workerEntrypoint = join(
  butlerHome,
  "packages",
  "butler-agent",
  "scripts",
  "run-worker.ts",
);
rmSync(root, { recursive: true, force: true });
mkdirSync(join(butlerHome, "packages", "butler-agent", "scripts"), {
  recursive: true,
});
mkdirSync(projectPath, { recursive: true });
writeFileSync(workerEntrypoint, [
  "import { writeFileSync } from 'node:fs';",
  "import { join } from 'node:path';",
  "const taskDir = process.argv[2];",
  "writeFileSync(join(taskDir, 'worker-proof.json'), JSON.stringify({",
  "  worker: process.env.BUTLER_WORKER,",
  "  taskId: process.env.TASK_ID_OVERRIDE,",
  "  secretSeen: Boolean(process.env.BUTLER_SECRET_TOKEN),",
  "}));",
  "process.stdout.write('worker-command-executor-ok\\n');",
].join("\n"), "utf8");

const executor = createPlatformCommandExecutor();
let cancellationResult = false;
const previousSecret = process.env.BUTLER_SECRET_TOKEN;
const previousButlerData = process.env.BUTLER_DATA;
const previousButlerHome = process.env.BUTLER_HOME;
process.env.BUTLER_SECRET_TOKEN = "must-not-cross-worker-boundary";
process.env.BUTLER_DATA = butlerData;
process.env.BUTLER_HOME = butlerHome;

try {
  const structured = await executor.execute({
    plan: {
      steps: [{
        executable: process.execPath,
        arguments: ["-e", "process.stdout.write('structured-ok')"],
      }],
    },
    timeoutMs: 5_000,
  });

  const compatibility = await executeLegacyCommandCompatibility(executor, {
    command: "Write-Output 'compatibility-ok'",
    cwd: projectPath,
    environment: {
      PATH: process.env.PATH,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      USERPROFILE: process.env.USERPROFILE,
      BUTLER_WINDOWS_PROCESS_HOST: process.env.BUTLER_WINDOWS_PROCESS_HOST,
    },
    timeoutMs: 5_000,
  });

  const missingExecutableSecret = "missing-windows-secret-executable";
  const normalizedError = await executor.execute({
    plan: { steps: [{ executable: missingExecutableSecret }] },
    environment: {
      PATH: process.env.PATH,
      SYSTEMROOT: process.env.SYSTEMROOT,
      WINDIR: process.env.WINDIR,
      PRIVATE_TEST_TOKEN: "windows-environment-secret",
    },
    inheritEnvironment: false,
    timeoutMs: 5_000,
  });

  dispatchBackgroundWorker({
    taskId,
    butlerHome,
    butlerData,
    task: "Produce deterministic worker smoke evidence.",
    projectPath,
    commandExecutor: executor,
  });
  await waitFor(() => readText(join(butlerData, "tasks", taskId, "status")) === "DONE");

  const cancellationId = "windows-control-cancellation";
  const cancellationTaskDir = join(butlerData, "tasks", cancellationId);
  const cancellationControl = backgroundCommandControlPaths(
    butlerData,
    cancellationId,
  );
  mkdirSync(cancellationTaskDir, { recursive: true });
  writeFileSync(join(cancellationTaskDir, "status"), "RUNNING\n", "utf8");
  startRegisteredBackgroundCommand({
    id: cancellationId,
    executor,
    control: cancellationControl,
    request: {
      plan: {
        steps: [{
          executable: process.execPath,
          arguments: ["-e", "setInterval(() => {}, 1000)"],
        }],
      },
      timeoutMs: 30_000,
    },
    onSettled: (result) => {
      cancellationResult = result.cancelled && result.exitCode === null;
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  writeFileSync(
    cancellationControl.cancellationFile,
    "external cancellation request\n",
    "utf8",
  );
  const cancellationAccepted = existsSync(cancellationControl.cancellationFile);
  await waitFor(() => registeredBackgroundCommandCount() === 0);

  const taskDir = join(butlerData, "tasks", taskId);
  const workerProof = JSON.parse(
    readFileSync(join(taskDir, "worker-proof.json"), "utf8"),
  ) as Record<string, unknown>;
  const result = {
    ok:
      structured.stdout === "structured-ok" &&
      structured.exitCode === 0 &&
      compatibility.stdout.trim() === "compatibility-ok" &&
      compatibility.exit_code === 0 &&
      normalizedError.exitCode === null &&
      normalizedError.error?.code === "command_spawn_failed" &&
      !JSON.stringify(normalizedError).includes(missingExecutableSecret) &&
      !JSON.stringify(normalizedError).includes("windows-environment-secret") &&
      readText(join(taskDir, "result.md")) === "worker-command-executor-ok" &&
      workerProof.worker === "1" &&
      workerProof.taskId === taskId &&
      workerProof.secretSeen === false &&
      cancellationAccepted &&
      cancellationResult &&
      !existsSync(join(taskDir, "pid")) &&
      !existsSync(join(taskDir, "pgid")),
    platform: "win32-x64",
    standardUser: process.env.BUTLER_WINDOWS_STANDARD_USER === "1",
    structuredCommand: structured.exitCode === 0,
    compatibilityBoundary: compatibility.exit_code === 0,
    normalizedError: normalizedError.error?.code === "command_spawn_failed",
    backgroundWorker: readText(join(taskDir, "status")) === "DONE",
    sanitizedEnvironment: workerProof.secretSeen === false,
    registeredCancellation: cancellationAccepted && cancellationResult,
    pidDialectLeak: existsSync(join(taskDir, "pid")) || existsSync(join(taskDir, "pgid")),
    rawTextIncluded: false,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
} finally {
  if (previousSecret === undefined) delete process.env.BUTLER_SECRET_TOKEN;
  else process.env.BUTLER_SECRET_TOKEN = previousSecret;
  if (previousButlerData === undefined) delete process.env.BUTLER_DATA;
  else process.env.BUTLER_DATA = previousButlerData;
  if (previousButlerHome === undefined) delete process.env.BUTLER_HOME;
  else process.env.BUTLER_HOME = previousButlerHome;
  rmSync(root, { recursive: true, force: true });
}

async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Windows control smoke timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}
