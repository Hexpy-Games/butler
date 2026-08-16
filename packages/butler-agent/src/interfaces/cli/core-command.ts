#!/usr/bin/env bun
import { spawnSync } from "child_process";

import { buildMetricsStatus, renderMetricsStatus } from "../../../scripts/metrics-status.ts";
import { buildServiceHealth, renderStatusContext } from "../../../scripts/status-context.ts";
import { getModelProviderControlStatus, renderModelProviderControlStatus } from "../../integrations/providers/control-plane.ts";
import {
  buildPlatformDoctorReport,
  PlatformDoctorInputError,
  renderPlatformDoctorReport,
} from "../../operations/doctor/platform-doctor.ts";
import { parseCommonOptions, type ParsedCommonOptions } from "./args.ts";
import { renderJsonEnvelope } from "./output.ts";
import { loadPrivateEnvIntoProcess, privateEnvPath } from "./private-env.ts";

function optionValue(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

function numericOption(args: string[], name: string): number | null {
  const value = optionValue(args, name);
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function safeCommand(args: string[]): string {
  const safeArgs = [...args];
  for (const flag of ["--token", "--check"]) {
    const valueIndex = safeArgs.indexOf(flag) + 1;
    if (valueIndex > 0 && safeArgs[valueIndex]) {
      safeArgs[valueIndex] = "[redacted]";
    }
  }
  return `butler ${safeArgs.join(" ")}`.trim();
}

function fail(
  parsed: ParsedCommonOptions,
  code: string,
  message: string,
  exitCode = 2,
): never {
  if (parsed.options.json) {
    process.stdout.write(renderJsonEnvelope({
      ok: false,
      command: safeCommand(parsed.args),
      error: { code, message },
    }));
  } else {
    console.error(message);
  }
  process.exit(exitCode);
}

function printEnvelope(parsed: ParsedCommonOptions, command: string, data: unknown): void {
  process.stdout.write(renderJsonEnvelope({
    ok: true,
    command,
    data,
  }));
}

function prepareEnvironment(parsed: ParsedCommonOptions): void {
  process.env.BUTLER_HOME = parsed.options.home;
  process.env.BUTLER_DATA = parsed.options.data;
  loadPrivateEnvIntoProcess(parsed.options.data);
}

function authStatus(parsed: ParsedCommonOptions): void {
  const configured = (() => {
    if (process.env.OPENAI_API_KEY?.trim()) {
      return { configured: true, mode: "api_key", source: "OPENAI_API_KEY" };
    }
    const profilePath = process.env.BUTLER_CODEX_AUTH_PROFILE ||
      process.env.BUTLER_OPENAI_AUTH_PROFILE ||
      `${parsed.options.data}/auth/openai-codex.json`;
    if (Bun.file(profilePath).size > 0) {
      return { configured: true, mode: "codex_subscription", source: "BUTLER_CODEX_AUTH_PROFILE" };
    }
    const codexAuthPath = process.env.CODEX_AUTH_JSON ||
      `${process.env.HOME || ""}/.codex/auth.json`;
    if (Bun.file(codexAuthPath).size > 0) {
      return { configured: true, mode: "codex_oauth", source: "CODEX_AUTH_JSON" };
    }
    return { configured: false, mode: "missing", source: null };
  })();
  const data = {
    ...configured,
    envPath: privateEnvPath(parsed.options.data),
    redacted: true,
  };

  if (parsed.options.json) {
    printEnvelope(parsed, "butler auth status", data);
  } else {
    console.log([
      "Butler auth",
      `configured: ${data.configured}`,
      `mode: ${data.mode}`,
      `source: ${data.source ?? "none"}`,
      "secrets: redacted",
    ].join("\n"));
  }
}

function authLogin(parsed: ParsedCommonOptions): never {
  if (parsed.options.nonInteractive) {
    fail(parsed, "invalid_arguments", "auth login requires an interactive browser flow");
  }
  const result = spawnSync(process.execPath, [
    "run",
    `${parsed.options.home}/packages/butler-agent/scripts/openai-oauth-login.ts`,
  ], {
    cwd: parsed.options.home,
    stdio: "inherit",
    env: process.env,
  });
  process.exit(result.status ?? 1);
}

function modelStatus(parsed: ParsedCommonOptions): void {
  const status = getModelProviderControlStatus();
  if (parsed.options.json) {
    printEnvelope(parsed, "butler model status", status);
  } else {
    console.log(renderModelProviderControlStatus(status));
  }
}

function status(parsed: ParsedCommonOptions, args: string[]): void {
  const sinceHours = numericOption(args, "--since-hours");
  const data = {
    status: buildMetricsStatus({
      butlerData: parsed.options.data,
      sinceHours,
    }),
    services: buildServiceHealth(parsed.options.home, parsed.options.data),
    model: getModelProviderControlStatus({
      sinceTs: sinceHours === null ? undefined : Date.now() - sinceHours * 60 * 60 * 1000,
    }),
  };
  if (parsed.options.json) {
    printEnvelope(parsed, "butler status", data);
  } else {
    console.log(renderStatusContext());
  }
}

async function doctor(parsed: ParsedCommonOptions, args: string[]): Promise<void> {
  if (args.includes("--fix") || args.includes("--collect-logs") || args.includes("--github")) {
    fail(
      parsed,
      "unsupported_logical_operation",
      "this doctor operation is not supported by the platform-neutral diagnostic surface",
      3,
    );
  }
  try {
    const report = await buildPlatformDoctorReport({
      butlerHome: parsed.options.home,
      butlerData: parsed.options.data,
      check: optionValue(args, "--check"),
    });
    if (parsed.options.json) {
      printEnvelope(parsed, "butler doctor", report);
    } else if (!parsed.options.quiet) {
      process.stdout.write(renderPlatformDoctorReport(report));
    }
    if (report.exitCode !== 0) process.exit(report.exitCode);
  } catch (error) {
    if (error instanceof PlatformDoctorInputError) {
      fail(parsed, error.code, error.message, 2);
    }
    fail(parsed, "doctor_failed", "platform-neutral doctor failed", 4);
  }
}

function metrics(parsed: ParsedCommonOptions, args: string[]): never | void {
  const [subcommand = "status", ...rest] = args;
  const sinceHours = numericOption(rest, "--since-hours");
  if (subcommand === "status") {
    const data = buildMetricsStatus({
      butlerData: parsed.options.data,
      sinceHours,
    });
    if (parsed.options.json) {
      printEnvelope(parsed, "butler metrics status", data);
    } else {
      console.log(renderMetricsStatus(data));
    }
    return;
  }
  const result = spawnSync(process.execPath, [
    "run",
    `${parsed.options.home}/packages/butler-agent/scripts/metrics-status.ts`,
    subcommand,
    ...rest,
    ...(parsed.options.json ? ["--json"] : []),
  ], {
    cwd: parsed.options.home,
    stdio: "inherit",
    env: process.env,
  });
  process.exit(result.status ?? 1);
}

async function main(): Promise<void> {
  const parsed = parseCommonOptions(Bun.argv.slice(2));
  if (parsed.errors.length > 0) {
    fail(parsed, "invalid_arguments", parsed.errors.join("; "));
  }
  prepareEnvironment(parsed);
  const [command, ...args] = parsed.args;
  if (command === "doctor") return await doctor(parsed, args);
  if (command === "status") return status(parsed, args);
  if (command === "metrics") return metrics(parsed, args);
  if (command === "auth" && args[0] === "status") return authStatus(parsed);
  if (command === "auth" && args[0] === "login") return authLogin(parsed);
  if (command === "model" && args[0] === "status") return modelStatus(parsed);
  fail(parsed, "unknown_command", `unknown Butler core command: ${parsed.args.join(" ")}`);
}

if (import.meta.main) {
  await main();
}
