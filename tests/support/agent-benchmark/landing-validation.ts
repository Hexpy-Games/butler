import { relative, join } from "node:path";
import {
  resolveBenchmarkBrowserExecutable,
  validateProjectDeliverable,
} from "../btcc-revision-benchmark/project-deliverable-validation.ts";
import type { BenchmarkArmPlan, BenchmarkFixture, LandingValidation } from "./contracts.ts";
import { createProcessExecutor, type CommandExecutor, type CommandResult } from "./command.ts";

export async function validateLandingWorkspace(input: {
  arm: BenchmarkArmPlan;
  fixture: BenchmarkFixture;
  executor?: CommandExecutor;
}): Promise<LandingValidation> {
  const diagnostics: string[] = [];
  let browserPath: string;
  try {
    browserPath = resolveBenchmarkBrowserExecutable();
  } catch {
    return unavailableValidation("browser_missing");
  }
  const executor = input.executor ?? createProcessExecutor();
  const declaredBuild = input.fixture.requiredBuildCommand
    ? await executeFixedCommand(executor, input.fixture.requiredBuildCommand, input.arm)
    : null;
  if (declaredBuild && (declaredBuild.exitCode !== 0 || declaredBuild.timedOut)) {
    return {
      ...unavailableValidation("declared-build-command-failed"),
      browserAvailable: true,
      buildPassed: false,
    };
  }
  const validation = await validateProjectDeliverable({
    browserExecutablePath: browserPath,
    runRoot: input.arm.evidenceRoot,
    workspaceRoot: input.arm.outputRoot,
    env: landingValidationEnvironment(input.arm),
  }).catch((error: unknown) => {
    diagnostics.push(error instanceof Error ? error.message : String(error));
    return null;
  });
  const testResult = input.fixture.requiredTestCommand
    ? await executeFixedCommand(executor, input.fixture.requiredTestCommand, input.arm)
    : null;
  const buildPassed = validation?.build.exitCode === 0 && validation?.build.timedOut === false;
  const testPassed = testResult ? testResult.exitCode === 0 && !testResult.timedOut : null;
  if (testResult && !testPassed) diagnostics.push("declared-test-command-failed");
  if (validation && !buildPassed) diagnostics.push("declared-build-command-failed");
  return {
    buildPassed,
    testPassed,
    browserAvailable: validation !== null,
    desktop: {
      loaded: validation?.desktop.loaded ?? false,
      overflowFree: validation !== null && validation.desktop.scrollWidth !== null && validation.desktop.clientWidth !== null
        ? validation.desktop.scrollWidth <= validation.desktop.clientWidth
        : false,
      screenshotRef: validation?.desktop.screenshotPath ? relative(input.arm.evidenceRoot, validation.desktop.screenshotPath) : null,
    },
    mobile: {
      loaded: validation?.mobile.loaded ?? false,
      overflowFree: validation !== null && validation.mobile.scrollWidth !== null && validation.mobile.clientWidth !== null
        ? validation.mobile.scrollWidth <= validation.mobile.clientWidth
        : false,
      screenshotRef: validation?.mobile.screenshotPath ? relative(input.arm.evidenceRoot, validation.mobile.screenshotPath) : null,
    },
    visualQuality: null,
    diagnostics: diagnostics.map((value) => value.slice(-500)),
  };
}

async function executeFixedCommand(
  executor: CommandExecutor,
  command: readonly string[],
  arm: BenchmarkArmPlan,
): Promise<CommandResult> {
  const [executable, ...args] = command;
  if (!executable) throw new Error("Declared landing command is empty");
  return executor.execute({
    executable,
    args,
    cwd: arm.outputRoot,
    env: landingValidationEnvironment(arm),
    timeoutMs: arm.timeoutMs,
    signal: new AbortController().signal,
  });
}

function landingValidationEnvironment(arm: BenchmarkArmPlan): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "LANG", "LC_ALL", "TMPDIR"] as const) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  environment.HOME = join(arm.dataRoot, "home");
  environment.XDG_CONFIG_HOME = join(arm.dataRoot, "xdg-config");
  environment.XDG_DATA_HOME = join(arm.dataRoot, "xdg-data");
  environment.XDG_CACHE_HOME = join(arm.cacheRoot, "xdg-cache");
  environment.npm_config_cache = join(arm.cacheRoot, "npm-cache");
  return environment;
}

function unavailableValidation(diagnostic: string): LandingValidation {
  return {
    buildPassed: null,
    testPassed: null,
    browserAvailable: false,
    desktop: { loaded: false, overflowFree: false, screenshotRef: null },
    mobile: { loaded: false, overflowFree: false, screenshotRef: null },
    visualQuality: null,
    diagnostics: [diagnostic],
  };
}
