import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CommandExecutor } from "../../runtime/command/contracts.ts";
import { createPlatformCommandExecutor } from "../../runtime/command/platform-command-executor.ts";

export const PLATFORM_DOCTOR_SCHEMA = "butler.platform-doctor.v1";
export const PLATFORM_DOCTOR_CHECK_IDS = [
  "command_execution",
  "runtime",
  "payload",
  "containment",
  "cancellation",
  "updater",
] as const;

export type PlatformDoctorCheckId = (typeof PLATFORM_DOCTOR_CHECK_IDS)[number];
export type PlatformDoctorCheckStatus = "pass" | "warn" | "fail";

export interface PlatformDoctorCheck {
  id: PlatformDoctorCheckId;
  status: PlatformDoctorCheckStatus;
  summary: string;
  evidence: Readonly<Record<string, string | number | boolean | null>>;
}

export interface PlatformDoctorReport {
  schema: typeof PLATFORM_DOCTOR_SCHEMA;
  status: "healthy" | "degraded";
  exitCode: 0 | 1;
  checks: PlatformDoctorCheck[];
  capabilities: {
    commandExecution: boolean;
    processContainment: boolean;
    cancellation: boolean;
    managedPayload: boolean;
    updater: boolean;
    appForegroundAgent: true;
    backgroundServiceInstall: {
      supported: false;
      reason: "app_foreground_owned";
    };
  };
  rawTextIncluded: false;
}

export class PlatformDoctorInputError extends Error {
  readonly code = "unsupported_logical_operation";
}

export async function buildPlatformDoctorReport(input: {
  butlerHome: string;
  butlerData: string;
  env?: NodeJS.ProcessEnv;
  executor?: CommandExecutor;
  runtimeExecutable?: string;
  platform?: NodeJS.Platform;
  check?: string | null;
}): Promise<PlatformDoctorReport> {
  const env = input.env ?? process.env;
  const executor = input.executor ?? createPlatformCommandExecutor();
  const runtimeExecutable = input.runtimeExecutable ?? process.execPath;
  const platform = input.platform ?? process.platform;
  const requested = normalizeCheckFilter(input.check);
  const context = {
    butlerHome: input.butlerHome,
    butlerData: input.butlerData,
    env,
    executor,
    runtimeExecutable,
    platform,
  };
  const checks: PlatformDoctorCheck[] = [];
  if (selected(requested, "command_execution")) {
    checks.push(await commandExecutionCheck(context));
  }
  if (selected(requested, "runtime")) checks.push(await runtimeCheck(context));
  if (selected(requested, "payload")) checks.push(payloadCheck(context));
  if (selected(requested, "containment")) {
    checks.push(await containmentCheck(context));
  }
  if (selected(requested, "cancellation")) checks.push(cancellationCheck(context));
  if (selected(requested, "updater")) checks.push(updaterCheck(context));

  const healthy = checks.every((check) => check.status === "pass");
  const statusById = new Map(checks.map((check) => [check.id, check.status]));
  return {
    schema: PLATFORM_DOCTOR_SCHEMA,
    status: healthy ? "healthy" : "degraded",
    exitCode: healthy ? 0 : 1,
    checks,
    capabilities: {
      commandExecution: statusById.get("command_execution") !== "fail",
      processContainment: statusById.get("containment") !== "fail",
      cancellation: statusById.get("cancellation") !== "fail",
      managedPayload: statusById.get("payload") !== "fail",
      updater: statusById.get("updater") !== "fail",
      appForegroundAgent: true,
      backgroundServiceInstall: {
        supported: false,
        reason: "app_foreground_owned",
      },
    },
    rawTextIncluded: false,
  };
}

export function renderPlatformDoctorReport(report: PlatformDoctorReport): string {
  const lines = [`Butler doctor: ${report.status}`];
  for (const check of report.checks) {
    lines.push(`[${check.status.toUpperCase()}] ${check.id}: ${check.summary}`);
  }
  lines.push("Background service install: unsupported (App foreground Agent owns lifecycle)");
  return `${lines.join("\n")}\n`;
}

type DoctorContext = {
  butlerHome: string;
  butlerData: string;
  env: NodeJS.ProcessEnv;
  executor: CommandExecutor;
  runtimeExecutable: string;
  platform: NodeJS.Platform;
};

async function commandExecutionCheck(context: DoctorContext): Promise<PlatformDoctorCheck> {
  const marker = "butler-command-health";
  const result = await context.executor.execute({
    plan: {
      steps: [{
        executable: context.runtimeExecutable,
        arguments: ["-e", `process.stdout.write(${JSON.stringify(marker)})`],
      }],
    },
    timeoutMs: 5_000,
  });
  const passed = result.exitCode === 0 && result.stdout === marker && !result.error;
  return {
    id: "command_execution",
    status: passed ? "pass" : "fail",
    summary: passed
      ? "selected execution backend completed a structured command"
      : "structured command execution is unavailable",
    evidence: {
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      cancelled: result.cancelled,
      durationMs: result.durationMs,
      rawTextIncluded: false,
    },
  };
}

async function runtimeCheck(context: DoctorContext): Promise<PlatformDoctorCheck> {
  const result = await context.executor.execute({
    plan: {
      steps: [{ executable: context.runtimeExecutable, arguments: ["--version"] }],
    },
    timeoutMs: 5_000,
  });
  const version = result.stdout.trim().split(/\s+/u)[0] ?? "";
  const passed = result.exitCode === 0 && /^\d+\.\d+/u.test(version);
  return {
    id: "runtime",
    status: passed ? "pass" : "fail",
    summary: passed ? "bundled runtime is executable" : "bundled runtime probe failed",
    evidence: {
      executable: passed,
      version: passed ? version : null,
      exitCode: result.exitCode,
      rawTextIncluded: false,
    },
  };
}

function payloadCheck(context: DoctorContext): PlatformDoctorCheck {
  const runtimeHome = context.env.BUTLER_APP_MANAGED_RUNTIME_HOME?.trim() ||
    context.butlerHome;
  const launcher = join(runtimeHome, "bin", "butler.js");
  const runtimeRoot = join(
    runtimeHome,
    "packages",
    "butler-agent",
    "resources",
    "runtime",
  );
  const required = [launcher, join(runtimeRoot, "bun-version")];
  if (context.platform === "win32" && context.env.BUTLER_APP_MANAGED_RUNTIME_HOME) {
    required.push(
      join(runtimeRoot, "bin", "bun.exe"),
      join(runtimeRoot, "bin", "butler-process-host.exe"),
      join(runtimeRoot, "windows-signatures.json"),
    );
  }
  const present = required.filter((path) => existsSync(path)).length;
  const passed = present === required.length;
  return {
    id: "payload",
    status: passed ? "pass" : "fail",
    summary: passed ? "managed Agent payload is complete" : "managed Agent payload is incomplete",
    evidence: {
      requiredFiles: required.length,
      presentFiles: present,
      appManaged: Boolean(context.env.BUTLER_APP_MANAGED_RUNTIME_HOME),
      rawTextIncluded: false,
    },
  };
}

async function containmentCheck(context: DoctorContext): Promise<PlatformDoctorCheck> {
  const result = await context.executor.execute({
    plan: {
      steps: [{
        executable: context.runtimeExecutable,
        arguments: ["-e", "setInterval(() => {}, 1000)"],
      }],
    },
    timeoutMs: 50,
  });
  const passed = result.timedOut && result.exitCode === null;
  return {
    id: "containment",
    status: passed ? "pass" : "fail",
    summary: passed ? "contained process stopped on deadline" : "process containment probe failed",
    evidence: {
      deadlineEnforced: result.timedOut,
      processStopped: result.exitCode === null,
      rawTextIncluded: false,
    },
  };
}

function cancellationCheck(context: DoctorContext): PlatformDoctorCheck {
  const requiredHost = context.platform === "win32"
    ? context.env.BUTLER_WINDOWS_PROCESS_HOST?.trim() ||
      join(dirname(context.runtimeExecutable), "butler-process-host.exe")
    : null;
  const passed = requiredHost === null || existsSync(requiredHost);
  return {
    id: "cancellation",
    status: passed ? "pass" : "fail",
    summary: passed
      ? "local cancellation transport prerequisites are available"
      : "local cancellation transport prerequisite is missing",
    evidence: {
      authenticatedTransport: true,
      boundedFrames: true,
      nativeHostPresent: requiredHost === null ? true : existsSync(requiredHost),
      rawTextIncluded: false,
    },
  };
}

function updaterCheck(context: DoctorContext): PlatformDoctorCheck {
  const versionFile = join(
    context.butlerHome,
    "packages",
    "butler-agent",
    "resources",
    "runtime",
    "bun-version",
  );
  const appManaged = context.env.BUTLER_APP_MANAGED_RUNTIME_HOME?.trim();
  const appVersionFile = appManaged
    ? join(
        appManaged,
        "packages",
        "butler-agent",
        "resources",
        "runtime",
        "bun-version",
      )
    : null;
  const passed = existsSync(appVersionFile ?? versionFile);
  return {
    id: "updater",
    status: passed ? "pass" : "warn",
    summary: passed ? "runtime version metadata is available" : "runtime version metadata is unavailable",
    evidence: {
      versionMetadata: passed,
      rollbackPolicy: "preserve_previous_runtime",
      rawTextIncluded: false,
    },
  };
}

function normalizeCheckFilter(value: string | null | undefined): PlatformDoctorCheckId | null {
  const normalized = value?.trim() || null;
  if (normalized === null) return null;
  if (PLATFORM_DOCTOR_CHECK_IDS.includes(normalized as PlatformDoctorCheckId)) {
    return normalized as PlatformDoctorCheckId;
  }
  throw new PlatformDoctorInputError("unsupported doctor check");
}

function selected(
  requested: PlatformDoctorCheckId | null,
  check: PlatformDoctorCheckId,
): boolean {
  return requested === null || requested === check;
}
