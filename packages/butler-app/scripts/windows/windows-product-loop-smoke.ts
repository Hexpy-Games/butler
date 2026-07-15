import { spawn, spawnSync } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { windowsValidationToken } from "./windows-validation-token.ts";

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("Windows product loop smoke requires Windows x64");
}

const repoRoot = process.cwd();
const passCount = 2;
const validationToken = windowsValidationToken();
const standardUser = validationToken.standardUser;
if (!validationToken.accepted) {
  throw new Error("Windows product loop smoke requires a standard user token");
}
const initialE2eTempDirs = currentE2eTempDirs();

const passes: Array<Record<string, unknown>> = [];
for (let pass = 1; pass <= passCount; pass += 1) {
  const chat = await runJsonScenario(
    `chat-${pass}`,
    ["run", "tests/e2e/app-client-multiturn-e2e.ts"],
    { BUTLER_APP_CLIENT_E2E_MODE: "deterministic" },
  );
  await waitForE2eTempCleanup(initialE2eTempDirs);
  const project = await runJsonScenario(
    `project-${pass}`,
    ["run", "tests/e2e/app-client-multiturn-e2e.ts"],
    { BUTLER_APP_CLIENT_E2E_MODE: "toolchain" },
  );
  await waitForE2eTempCleanup(initialE2eTempDirs);
  await runExitScenario(`command-${pass}`, [
    "test",
    "tests/unit/native-tool-loop-runtime.test.ts",
    "--test-name-pattern",
    "native runtime can drive the real run_command tool through the default executor",
  ]);
  await runExitScenario(`background-${pass}`, [
    "test",
    "tests/unit/inbound-queue.test.ts",
    "tests/unit/app-worker-cancel.test.ts",
    "tests/unit/work-orchestration.test.ts",
  ]);
  await runExitScenario(`scheduler-${pass}`, [
    "test",
    "tests/unit/native-scheduler.test.ts",
    "--test-name-pattern",
    "native scheduler claims due automations into the inbound queue",
  ]);
  const stop = await runJsonScenario(
    `stop-${pass}`,
    ["run", "packages/butler-app/scripts/windows/active-work-cancellation-smoke.ts"],
  );
  const containment = await runJsonScenario(
    `containment-${pass}`,
    ["run", "packages/butler-app/scripts/windows/app-foreground-lifecycle-smoke.ts"],
  );
  const desktop = await runJsonScenario(
    `desktop-${pass}`,
    ["run", "packages/butler-app/scripts/windows/unpacked-foreground-app-smoke.ts"],
  );

  const chatChecks = stringArray(chat.checks);
  const projectChecks = stringArray(project.checks);
  const projectTools = stringArray(project.toolCalls);
  const passResult = {
    pass,
    deterministicChat:
      chatChecks.includes("composer-two-turn-flow") &&
      chatChecks.includes("durable-final-transcript-continuity"),
    projectToolchain:
      projectChecks.includes("project-ledger-read-write-toolchain") &&
      [
        "inspect_project_status",
        "query_project_work",
        "render_project_dashboard",
      ].every((name) => projectTools.includes(name)),
    commandTool: true,
    stopAndBackgroundWork:
      stop.exactTurnCancellation === true &&
      stop.exactWorkerCancellation === true &&
      stop.boundedDrain === true,
    restartDataReload:
      chatChecks.includes("electron-reload-preserved-session-state") &&
      chatChecks.includes("canonical-session-view-consistent"),
    agentCrashRecovery: desktop.boundedRecovery === true,
    normalQuit:
      desktop.gracefulQuit === true &&
      objectRecord(containment.normalStop)?.processTreeDead === true,
    forceKill:
      objectRecord(containment.ownerDeath)?.processTreeDead === true,
    portRelease:
      desktop.portReleased === true &&
      objectRecord(containment.normalStop)?.portReleased === true &&
      objectRecord(containment.ownerDeath)?.portReleased === true,
    rawTextIncluded: false,
  };
  if (Object.entries(passResult).some(([key, value]) =>
    !["pass", "rawTextIncluded"].includes(key) && value !== true,
  )) {
    throw new Error(`Windows product loop pass ${pass} did not satisfy every gate`);
  }
  passes.push(passResult);
}
await waitForE2eTempCleanup(initialE2eTempDirs);

const result = {
  ok: passes.length === passCount,
  platform: `${process.platform}-${process.arch}`,
  standardUser,
  ciElevatedToken: validationToken.ciElevatedToken,
  cleanIsolatedData: true,
  passes,
  rawTextIncluded: false,
};
process.stdout.write(`${JSON.stringify(result)}\n`);

async function runJsonScenario(
  label: string,
  args: string[],
  environment: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const output = await runScenario(label, args, environment);
  for (const line of output.split(/\r?\n/u).reverse()) {
    const value = line.trim();
    if (!value.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(value) as Record<string, unknown>;
      if (parsed.ok === true) return parsed;
    } catch {
      // Continue searching for the scenario's final structured result.
    }
  }
  throw new Error(`${label} did not emit an ok result`);
}

async function runExitScenario(
  label: string,
  args: string[],
  environment: Record<string, string> = {},
): Promise<void> {
  await runScenario(label, args, environment);
}

async function runScenario(
  label: string,
  args: string[],
  environment: Record<string, string>,
): Promise<string> {
  const child = spawn(process.execPath, args, {
    cwd: repoRoot,
    env: { ...process.env, ...environment },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: false,
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      output = `${output}${String(chunk)}`.slice(-1_048_576);
    });
  }
  const exit = await new Promise<number | null>((resolveExit, reject) => {
    const timer = setTimeout(() => {
      terminateWindowsProcessTree(child.pid);
      reject(new Error(
        `${label} timed out\n${scenarioDiagnostic(output)}`,
      ));
    }, 300_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolveExit(code);
    });
  });
  if (exit !== 0) {
    throw new Error(
      `${label} failed with exit code ${exit ?? "null"}\n${scenarioDiagnostic(output)}`,
    );
  }
  return output;
}

function terminateWindowsProcessTree(pid: number | undefined): void {
  if (!Number.isInteger(pid) || !pid) return;
  spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
    encoding: "utf8",
    windowsHide: true,
  });
}

function scenarioDiagnostic(output: string): string {
  return output
    .replaceAll(repoRoot, "<repo>")
    .replace(/[A-Z]:\\Users\\[^\\\r\n]+\\AppData\\Local\\Temp/giu, "<temp>")
    .slice(-12_000);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function currentE2eTempDirs(): Set<string> {
  return new Set(
    readdirSync(tmpdir(), { withFileTypes: true })
      .filter((entry) =>
        entry.isDirectory() &&
        entry.name.startsWith("butler-app-client-multiturn-e2e-"),
      )
      .map((entry) => entry.name),
  );
}

async function waitForE2eTempCleanup(initial: Set<string>): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const remaining = [...currentE2eTempDirs()]
      .filter((name) => !initial.has(name));
    if (remaining.length === 0) return;
    for (const name of remaining) {
      try {
        rmSync(join(tmpdir(), name), { recursive: true, force: true });
      } catch (error) {
        if (!["EBUSY", "EPERM", "ENOTEMPTY"].includes(
          String((error as NodeJS.ErrnoException)?.code),
        )) {
          throw error;
        }
      }
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error("Windows E2E temporary data cleanup did not settle");
}
