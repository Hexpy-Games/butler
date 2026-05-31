#!/usr/bin/env bun
import { homedir } from "os";
import {
  applyOsServiceRegistrationPlan,
  createOsServiceRegistrationPlan,
  type OsServicePlatformSelection,
  type OsServiceRegistrationAction,
} from "../src/operations/service/os-service-adapter.ts";
import { parseCommonOptions } from "../src/interfaces/cli/args.ts";
import { renderJsonEnvelope } from "../src/interfaces/cli/output.ts";

function optionValue(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function safeCommand(args: string[]): string {
  return `butler service ${args.join(" ")}`.trim();
}

function fail(commandArgs: string[], code: string, message: string): never {
  process.stdout.write(renderJsonEnvelope({
    ok: false,
    command: safeCommand(commandArgs),
    error: { code, message },
  }));
  process.exit(2);
}

function parseAction(value: string | undefined): OsServiceRegistrationAction {
  if (value === "install" || value === "uninstall" || value === "status") return value;
  throw new Error(`unknown service registration command: ${value ?? ""}`);
}

function parsePlatform(value: string | null): OsServicePlatformSelection {
  if (!value) return "auto";
  if (value === "auto" || value === "launchd" || value === "systemd") return value;
  throw new Error(`unsupported service platform: ${value}`);
}

const parsed = parseCommonOptions(Bun.argv.slice(2));
if (parsed.errors.length > 0) {
  fail(parsed.args, "invalid_arguments", parsed.errors.join("; "));
}

let action: OsServiceRegistrationAction;
let platform: OsServicePlatformSelection;
try {
  action = parseAction(parsed.args[0]);
  platform = parsePlatform(optionValue(parsed.args, "--platform"));
} catch (error) {
  fail(parsed.args, "invalid_arguments", error instanceof Error ? error.message : String(error));
}

const dryRun = action !== "status" && (!parsed.options.yes || hasFlag(parsed.args, "--dry-run"));
const command = safeCommand([action]);
const plan = createOsServiceRegistrationPlan({
  action,
  platform,
  butlerHome: parsed.options.home,
  butlerData: parsed.options.data,
  homeDir: homedir(),
});

if (dryRun) {
  const data = {
    dryRun: true,
    mutated: false,
    requiresYes: true,
    plan,
  };
  if (parsed.options.json) {
    process.stdout.write(renderJsonEnvelope({ ok: true, command, data }));
  } else if (!parsed.options.quiet) {
    process.stdout.write([
      `Butler service ${action} plan (${plan.platform})`,
      `Service file: ${plan.serviceFile}`,
      `Foreground entrypoint: ${plan.foregroundEntrypoint}`,
      "No changes made. Re-run with --yes to apply.",
      "",
      "Commands:",
      ...plan.steps.map((step) => `  ${step.argv.join(" ")}`),
    ].join("\n"));
  }
  process.exit(0);
}

try {
  const result = applyOsServiceRegistrationPlan(plan);
  const data = {
    dryRun: false,
    mutated: result.mutated,
    plan,
    result,
  };
  if (parsed.options.json) {
    process.stdout.write(renderJsonEnvelope({ ok: true, command, data }));
  } else if (!parsed.options.quiet) {
    process.stdout.write([
      `Butler service ${action} ${result.mutated ? "applied" : "checked"} (${plan.platform})`,
      `Service file: ${result.serviceFile}`,
      ...result.commands.map((step) => `  ${step.exitCode}: ${step.argv.join(" ")}`),
    ].join("\n"));
  }
} catch (error) {
  if (parsed.options.json) {
    process.stdout.write(renderJsonEnvelope({
      ok: false,
      command,
      error: {
        code: "external_unavailable",
        message: error instanceof Error ? error.message : String(error),
      },
    }));
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exit(5);
}
