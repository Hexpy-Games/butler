import { spawn, spawnSync } from "node:child_process";
import { windowsValidationToken } from "./windows-validation-token.ts";

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("Windows product loop smoke requires Windows x64");
}

const repoRoot = process.cwd();
const fullProductPassCount = 1;
const platformPassCount = 2;
const validationToken = windowsValidationToken();
const standardUser = validationToken.standardUser;
if (!validationToken.accepted) {
  throw new Error("Windows product loop smoke requires a standard user token");
}

const passes: Array<Record<string, unknown>> = [];
const platformPasses: Array<Record<string, unknown>> = [];
for (let pass = 1; pass <= fullProductPassCount; pass += 1) {
  const appBtcc = await runJsonScenario(
    `app-btcc-${pass}`,
    [
      "run",
      "tests/e2e/windows-app-btcc-product-harness.ts",
      "--browser",
    ],
  );
  const projectContracts = await runExitScenario(`project-btcc-${pass}`, [
    "test",
    "--timeout",
    "120000",
    "tests/unit/btcc-project-work-ledger-session.test.ts",
    "tests/unit/btcc-production-operations.test.ts",
  ]);
  const commandRuntime = await runExitScenario(`command-${pass}`, [
    "test",
    "--timeout",
    "120000",
    "tests/unit/platform-command-executor.test.ts",
    "tests/unit/btcc-command-sandbox.test.ts",
  ]);
  await runExitScenario(`background-${pass}`, [
    "test",
    "--timeout",
    "120000",
    "tests/unit/inbound-queue.test.ts",
    "tests/unit/app-worker-cancel.test.ts",
    "tests/unit/work-orchestration.test.ts",
  ]);
  await runExitScenario(`scheduler-${pass}`, [
    "test",
    "--timeout",
    "120000",
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

  const platformChecks = platformGateChecks(containment, desktop);
  const passResult = {
    pass,
    appIngress: appBtcc.appIngress === true,
    deterministicConversation: appBtcc.deterministicConversation === true,
    conversationContinuity: appBtcc.conversationContinuity === true,
    canonicalProjection: appBtcc.canonicalProjection === true,
    browserProjection: appBtcc.browserProjection === true,
    projectContracts,
    commandRuntime,
    stopAndBackgroundWork:
      stop.exactTurnCancellation === true &&
      stop.exactWorkerCancellation === true &&
      stop.boundedDrain === true,
    restartDataReload: appBtcc.restartDataReload === true,
    ...platformChecks,
    rawTextIncluded: false,
  };
  assertAllGates(`Windows full-product pass ${pass}`, passResult);
  passes.push(passResult);
  platformPasses.push({ pass, ...platformChecks, rawTextIncluded: false });
}

for (
  let pass = fullProductPassCount + 1;
  pass <= platformPassCount;
  pass += 1
) {
  const containment = await runJsonScenario(
    `containment-${pass}`,
    ["run", "packages/butler-app/scripts/windows/app-foreground-lifecycle-smoke.ts"],
  );
  const desktop = await runJsonScenario(
    `desktop-${pass}`,
    ["run", "packages/butler-app/scripts/windows/unpacked-foreground-app-smoke.ts"],
  );
  const platformResult = {
    pass,
    ...platformGateChecks(containment, desktop),
    rawTextIncluded: false,
  };
  assertAllGates(`Windows platform lifecycle pass ${pass}`, platformResult);
  platformPasses.push(platformResult);
}

const result = {
  ok:
    passes.length === fullProductPassCount &&
    platformPasses.length === platformPassCount,
  platform: `${process.platform}-${process.arch}`,
  standardUser,
  ciElevatedToken: validationToken.ciElevatedToken,
  cleanIsolatedData: true,
  passes,
  platformPasses,
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
): Promise<boolean> {
  await runScenario(label, args, environment);
  return true;
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
  const redacted = output
    .replaceAll(repoRoot, "<repo>")
    .replace(/[A-Z]:\\Users\\[^\\\r\n]+\\AppData\\Local\\Temp/giu, "<temp>");
  if (redacted.length <= 12_000) return redacted;
  return [
    redacted.slice(0, 4_000),
    "... diagnostic middle omitted ...",
    redacted.slice(-8_000),
  ].join("\n");
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function platformGateChecks(
  containment: Record<string, unknown>,
  desktop: Record<string, unknown>,
): Record<string, boolean> {
  return {
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
  };
}

function assertAllGates(label: string, result: Record<string, unknown>): void {
  if (Object.entries(result).some(([key, value]) =>
    !["pass", "rawTextIncluded"].includes(key) && value !== true,
  )) {
    throw new Error(`${label} did not satisfy every gate`);
  }
}
