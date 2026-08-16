#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOME = homedir();
const commands = JSON.parse(readFileSync(
  resolve(root, "packages", "butler-agent", "src", "interfaces", "cli", "commands.json"),
  "utf8",
));
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const priorityLabels = {
  core: "Core",
  operator: "Operator",
  advanced: "Advanced",
  deferred: "Deferred",
};

function expandHome(value) {
  if (!value) return value;
  if (value === "~") return HOME;
  if (value.startsWith("~/")) return join(HOME, value.slice(2));
  return value;
}

function parseCommonOptions(rawArgs) {
  const args = [];
  const errors = [];
  let home = process.env.BUTLER_HOME || join(HOME, "butler");
  let data = process.env.BUTLER_DATA || join(HOME, ".butler");
  const options = {
    json: false,
    verbose: false,
    quiet: false,
    yes: false,
    nonInteractive: false,
    help: false,
  };

  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = rawArgs[i];
    if (arg === "--home") {
      const value = rawArgs[i + 1];
      if (!value || value.startsWith("--")) {
        errors.push("--home requires a path");
      } else {
        home = expandHome(value);
        i += 1;
      }
    } else if (arg === "--data") {
      const value = rawArgs[i + 1];
      if (!value || value.startsWith("--")) {
        errors.push("--data requires a path");
      } else {
        data = expandHome(value);
        i += 1;
      }
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--verbose") {
      options.verbose = true;
    } else if (arg === "--quiet") {
      options.quiet = true;
    } else if (arg === "--yes") {
      options.yes = true;
    } else if (arg === "--non-interactive") {
      options.nonInteractive = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      args.push(arg);
    }
  }
  return {
    args,
    home,
    data,
    options,
    errors,
  };
}

function resolveBun(data) {
  if (process.env.BUTLER_BUN) return process.env.BUTLER_BUN;
  const managedRoot = join(data, "runtime", "bun", "current", "bin");
  for (const executable of ["bun.exe", "bun"]) {
    const managed = join(managedRoot, executable);
    if (existsSync(managed)) return managed;
  }
  return "bun";
}

function run(program, programArgs, common) {
  const result = spawnSync(program, programArgs, {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      BUTLER_HOME: common.home,
      BUTLER_DATA: common.data,
      BUTLER_BUN: process.env.BUTLER_BUN || resolveBun(common.data),
    },
  });
  process.exit(result.status ?? 1);
}

function runBun(scriptArgs, common) {
  run(resolveBun(common.data), scriptArgs, common);
}

function forwardedCommonArgs(common) {
  const args = [];
  if (common.options.json) args.push("--json");
  if (common.options.verbose) args.push("--verbose");
  if (common.options.quiet) args.push("--quiet");
  if (common.options.yes) args.push("--yes");
  if (common.options.nonInteractive) args.push("--non-interactive");
  if (common.options.help) args.push("--help");
  return args;
}

function commandJson(command) {
  return {
    id: command.id,
    usage: command.usage,
    path: command.path,
    aliases: command.aliases || [],
    priority: command.priority,
    status: command.status,
    summary: command.summary,
    implemented: command.implemented,
    supportsJson: command.supportsJson,
    spec: command.spec,
  };
}

function createJsonEnvelope({ ok, command, data = null, error = null, privacy = {} }) {
  return {
    ok,
    command,
    data: ok ? data : null,
    error,
    privacy: {
      rawTextIncluded: false,
      secretsIncluded: false,
      ...privacy,
    },
  };
}

function printJsonEnvelope(input) {
  process.stdout.write(`${JSON.stringify(createJsonEnvelope(input), null, 2)}\n`);
}

function groupCommands({ implementedOnly = false } = {}) {
  const groups = new Map();
  for (const command of commands) {
    if (implementedOnly && !command.implemented) continue;
    const group = groups.get(command.priority) || [];
    group.push(command);
    groups.set(command.priority, group);
  }
  return groups;
}

function help() {
  const lines = [
    "Butler CLI",
    "",
    "Usage:",
    "  butler <command> [options]",
    "",
    "Implemented commands:",
  ];

  const groups = groupCommands({ implementedOnly: true });
  for (const priority of ["core", "operator", "advanced", "deferred"]) {
    const group = groups.get(priority) || [];
    if (group.length === 0) continue;
    lines.push("", `${priorityLabels[priority]}:`);
    for (const command of group) {
      lines.push(`  ${command.usage}`);
    }
  }

  lines.push(
    "",
    "Discovery:",
    "  butler commands [--json]  Show the full command inventory, including planned commands.",
    "  butler help <command>     Show command or group help.",
    "",
    "Common options:",
    "  --home PATH              Override BUTLER_HOME.",
    "  --data PATH              Override BUTLER_DATA.",
    "  --json                   Emit machine-readable JSON when supported.",
    "  --verbose                Include extra safe diagnostics.",
    "  --quiet                  Suppress non-essential human text.",
    "  --yes                    Confirm safe non-interactive prompts.",
    "  --non-interactive        Fail instead of prompting for missing data.",
    "",
    "Defaults:",
    "  BUTLER_HOME: ~/butler",
    "  BUTLER_DATA: ~/.butler",
  );

  console.log(lines.join("\n"));
}

function renderCommands({ json }) {
  if (json) {
    printJsonEnvelope({
      ok: true,
      command: "butler commands",
      data: {
        commands: commands.map(commandJson),
      },
    });
    return;
  }

  const lines = ["Butler command inventory", ""];
  for (const priority of ["core", "operator", "advanced", "deferred"]) {
    const group = commands.filter((command) => command.priority === priority);
    lines.push(`${priorityLabels[priority]}:`);
    for (const command of group) {
      const state = command.implemented ? "available" : command.status;
      lines.push(`  ${command.usage}  (${state})`);
    }
    lines.push("");
  }
  process.stdout.write(lines.join("\n"));
}

function gitRevision() {
  const result = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

function runtimeSummary(common) {
  const bun = resolveBun(common.data);
  let version = null;
  const result = spawnSync(bun, ["--version"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      BUTLER_HOME: common.home,
      BUTLER_DATA: common.data,
    },
  });
  if (result.status === 0) version = result.stdout.trim() || null;
  return {
    bun,
    bunVersion: version,
    source: process.env.BUTLER_BUN ? "override" : existsSync(bun) ? "managed" : "system-fallback",
  };
}

function renderVersion(common) {
  const data = {
    version: packageJson.version,
    gitRevision: gitRevision(),
    runtime: runtimeSummary(common),
    butlerHome: common.home,
    butlerData: common.data,
  };

  if (common.options.json) {
    printJsonEnvelope({
      ok: true,
      command: "butler version",
      data,
    });
    return;
  }

  console.log([
    `Butler ${data.version}`,
    `Git revision: ${data.gitRevision || "unknown"}`,
    `Runtime: ${data.runtime.bunVersion || "unknown"} (${data.runtime.source})`,
    `BUTLER_HOME: ${data.butlerHome}`,
    `BUTLER_DATA: ${data.butlerData}`,
  ].join("\n"));
}

function findExactCommand(path) {
  return commands.find((command) => {
    if (command.path.length !== path.length) return false;
    return command.path.every((part, index) => part === path[index]);
  }) || null;
}

function findKnownCommand(path) {
  const sorted = [...commands].sort((left, right) => right.path.length - left.path.length);
  return sorted.find((command) => {
    if (command.path.length > path.length) return false;
    return command.path.every((part, index) => part === path[index]);
  }) || null;
}

function commandGroup(prefix) {
  return commands.filter((command) => {
    if (command.path.length <= prefix.length) return false;
    return prefix.every((part, index) => command.path[index] === part);
  });
}

function renderCommandHelp(path) {
  const known = findKnownCommand(path);
  const command = known || findExactCommand(path);
  if (command) {
    const lines = [
      command.usage,
      "",
      command.summary,
      "",
      `Priority: ${priorityLabels[command.priority]}`,
      `Status: ${command.implemented ? "available" : command.status}`,
      `Spec: ${command.spec}`,
      "",
      "Privacy: no default output may include secrets or raw private content.",
    ];
    console.log(lines.join("\n"));
    return true;
  }

  const group = commandGroup(path);
  if (group.length > 0) {
    const lines = [
      `Butler ${path.join(" ")} commands`,
      "",
    ];
    if (path[0] === "work") {
      lines.push(
        "This is a support and recovery surface, not the primary task UX.",
        "",
      );
    }
    for (const item of group) {
      const state = item.implemented ? "available" : item.status;
      lines.push(`  ${item.usage}  (${state})`);
    }
    console.log(lines.join("\n"));
    return true;
  }

  return false;
}

function unavailableCommand(command, common) {
  if (common.options.json) {
    printJsonEnvelope({
      ok: false,
      command: `butler ${common.args.join(" ")}`,
      error: {
        code: "feature_not_stable",
        message: `${command.usage} is specified but not implemented yet`,
      },
    });
  } else {
    console.error(`${command.usage} is specified but not implemented yet.`);
    console.error("Run `butler commands` to see available and planned commands.");
  }
  process.exit(2);
}

function unknownCommand(common) {
  if (common.options.json) {
    printJsonEnvelope({
      ok: false,
      command: `butler ${common.args.join(" ")}`,
      error: {
        code: "unknown_command",
        message: `unknown Butler command: ${common.args.join(" ")}`,
      },
    });
  } else {
    console.error(`Unknown Butler command: ${common.args.join(" ")}`);
    help();
  }
  process.exit(2);
}

function invalidArguments(common) {
  if (common.options.json) {
    printJsonEnvelope({
      ok: false,
      command: common.args.length > 0 ? `butler ${common.args.join(" ")}` : "butler",
      error: {
        code: "invalid_arguments",
        message: common.errors.join("; "),
      },
    });
  } else {
    console.error(`Invalid Butler arguments: ${common.errors.join("; ")}`);
  }
  process.exit(2);
}

function unsupportedJson(commandName, common) {
  if (common.options.json) {
    printJsonEnvelope({
      ok: false,
      command: `butler ${commandName}`,
      error: {
        code: "unsupported_json",
        message: `${commandName} does not support --json`,
      },
    });
  } else {
    console.error(`${commandName} does not support --json`);
  }
  process.exit(2);
}

function scriptArgs(args, common) {
  return [...args, ...forwardedCommonArgs(common)];
}

function installScriptArgs(args, common) {
  const forwarded = forwardedCommonArgs(common).filter((arg) => arg !== "--json");
  return [...args, ...forwarded];
}

function coreCommandArgs(command, args, common) {
  return [
    "run",
    resolve(root, "packages", "butler-agent", "src", "interfaces", "cli", "core-command.ts"),
    command,
    ...scriptArgs(args, common),
  ];
}

function operatorCommandArgs(command, args, common) {
  return [
    "run",
    resolve(root, "packages", "butler-agent", "src", "interfaces", "cli", "operator-command.ts"),
    command,
    ...scriptArgs(args, common),
  ];
}

function advancedCommandArgs(command, args, common) {
  return [
    "run",
    resolve(root, "packages", "butler-agent", "src", "interfaces", "cli", "advanced-command.ts"),
    command,
    ...scriptArgs(args, common),
  ];
}

function runtimeRepair(args, common) {
  const [runtimeCommand, ...runtimeArgs] = args;
  if (runtimeCommand !== "repair") {
    unknownCommand(common);
  }
  if (!common.options.yes) {
    if (common.options.json) {
      printJsonEnvelope({
        ok: false,
        command: "butler runtime repair",
        error: {
          code: "invalid_arguments",
          message: "runtime repair requires --yes",
        },
      });
    } else {
      console.error("runtime repair requires --yes");
    }
    process.exit(2);
  }
  run("bash", [resolve(root, "install.sh"), "--runtime-repair", ...runtimeArgs], common);
}

function gatewayCommand(args, common) {
  const [gatewayName, ...gatewayArgs] = args;
  if (gatewayName === "app") {
    runBun([
      "run",
      resolve(root, "packages", "butler-agent", "src", "gateways", "app", "interface", "cli", "app-gateway-cli.ts"),
      ...scriptArgs(gatewayArgs, common),
    ], common);
    return;
  }
  if (gatewayName === "run" && gatewayArgs[0] === "app") {
    runBun([
      "run",
      resolve(root, "packages", "butler-agent", "src", "gateways", "app", "interface", "cli", "app-gateway-cli.ts"),
      ...scriptArgs(gatewayArgs.slice(1), common),
    ], common);
    return;
  }
  runBun(operatorCommandArgs("gateway", args, common), common);
}

const common = parseCommonOptions(process.argv.slice(2));
const [command, ...args] = common.args;

if (common.errors.length > 0) {
  invalidArguments(common);
}

if (!command) {
  help();
  process.exit(0);
}

if (command === "help") {
  if (args.length > 0) {
    if (renderCommandHelp(args)) process.exit(0);
    unknownCommand(common);
  }
  help();
  process.exit(0);
}

if (common.options.help) {
  if (renderCommandHelp(common.args)) process.exit(0);
  unknownCommand(common);
}

if (command === "commands") {
  renderCommands({ json: common.options.json });
  process.exit(0);
}

if (command === "version") {
  renderVersion(common);
  process.exit(0);
}

const knownCommand = findKnownCommand(common.args);
if (knownCommand && !knownCommand.implemented) {
  unavailableCommand(knownCommand, common);
}

switch (command) {
  case "install":
    if (common.options.json) unsupportedJson("install", common);
    run("bash", [resolve(root, "install.sh"), ...installScriptArgs(args, common)], common);
    break;
  case "upgrade-report":
    run("bash", [resolve(root, "install.sh"), "--upgrade-report", ...scriptArgs(args, common)], common);
    break;
  case "doctor":
    runBun(coreCommandArgs(command, args, common), common);
    break;
  case "status":
    runBun(coreCommandArgs(command, args, common), common);
    break;
  case "metrics": {
    if (knownCommand?.priority === "operator") {
      runBun(operatorCommandArgs(command, args, common), common);
    } else {
      runBun(coreCommandArgs(command, args, common), common);
    }
    break;
  }
  case "auth":
  case "model":
    if (knownCommand?.priority === "operator") {
      runBun(operatorCommandArgs(command, args, common), common);
    } else if (knownCommand?.priority === "advanced") {
      runBun(advancedCommandArgs(command, args, common), common);
    } else {
      runBun(coreCommandArgs(command, args, common), common);
    }
    break;
  case "runtime":
    runtimeRepair(args, common);
    break;
  case "gateway":
    gatewayCommand(args, common);
    break;
  case "service": {
    const [serviceCommand] = args;
    if (serviceCommand === "run") {
      run("bash", [resolve(root, "packages", "butler-agent", "scripts", "service-daemon.sh")], common);
    } else if (serviceCommand === "launchd-plist" || serviceCommand === "systemd-unit") {
      runBun([
        "run",
        resolve(root, "packages", "butler-agent", "scripts", "os-service-adapter.ts"),
        serviceCommand,
        ...forwardedCommonArgs(common),
      ], common);
    } else if (["install", "status", "uninstall"].includes(serviceCommand)) {
      runBun([
        "run",
        resolve(root, "packages", "butler-agent", "scripts", "os-service-registration.ts"),
        serviceCommand,
        ...args.slice(1),
        ...forwardedCommonArgs(common),
      ], common);
    } else {
      unknownCommand(common);
    }
    break;
  }
  case "maintenance": {
    const [maintenanceCommand, ...maintenanceArgs] = args;
    if (maintenanceCommand === "context") {
      runBun(operatorCommandArgs(command, [maintenanceCommand, ...maintenanceArgs], common), common);
    } else {
      unknownCommand(common);
    }
    break;
  }
  case "update":
  case "uninstall":
  case "logs":
  case "ps":
  case "config":
  case "personalization":
  case "transport":
  case "mcp":
  case "skills":
  case "work":
  case "context":
  case "search":
  case "web":
    runBun(operatorCommandArgs(command, args, common), common);
    break;
  case "cognition":
  case "cog": {
    const [cognitionCommand, memoryCommand] = args;
    if (cognitionCommand === "memory" && ["ingest", "maintain"].includes(memoryCommand)) {
      runBun(advancedCommandArgs(command, args, common), common);
    } else {
      runBun(operatorCommandArgs(command, args, common), common);
    }
    break;
  }
  case "memory":
    runBun(operatorCommandArgs(command, args, common), common);
    break;
  case "automation":
    runBun(advancedCommandArgs(command, args, common), common);
    break;
  case "start":
    run("bash", [resolve(root, "packages", "butler-agent", "scripts", "service-control.sh"), command, ...scriptArgs(args, common)], common);
    break;
  case "stop":
  case "restart":
    run("bash", [resolve(root, "packages", "butler-agent", "scripts", `${command}-butler.sh`), ...scriptArgs(args, common)], common);
    break;
  default:
    unknownCommand(common);
}
