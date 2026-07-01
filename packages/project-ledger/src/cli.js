import { parseArgs } from "./args.js";
import { commandShouldFail, handle } from "./commands.js";
import { createEnvelope, errorFromUnknown } from "./errors.js";

function optionValue(argv, name) {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

function appendOption(argv, name, value) {
  if (!value || argv.includes(`--${name}`)) return argv;
  return [...argv, `--${name}`, value];
}

function createArgs(kind, recordId, tail) {
  if (kind === "work") return appendOption(["work", "create", ...tail], "id", recordId);
  if (kind === "task") {
    return appendOption(
      appendOption(["task", "create", ...tail], "id", recordId),
      "work",
      optionValue(tail, "parent"),
    );
  }
  if (kind === "attempt") {
    return appendOption(
      appendOption(["attempt", "start", ...tail], "id", recordId),
      "task",
      optionValue(tail, "parent"),
    );
  }
  return appendOption(appendOption(["record", "create", ...tail], "kind", kind), "id", recordId);
}

function recordActionArgs(action, id, tail) {
  return appendOption(["record", action, ...tail], "id", id);
}

function normalizeShortCommand(argv, executableName = "project-ledger") {
  const calledAsPl = executableName === "pl" || argv[0] === "pl";
  if (!calledAsPl) return { argv, short: false };

  const input = argv[0] === "pl" ? argv.slice(1) : argv;
  const command = input[0] ?? "help";
  const rest = input.slice(1);
  const id = rest[0];
  const tail = rest.slice(1);

  if (command === "list") {
    const kind = rest[0];
    return { argv: appendOption(["query", ...rest.slice(1)], "kind", kind), short: true };
  }
  if (command === "show") {
    return { argv: appendOption(["record", "show", ...tail], "id", id), short: true };
  }
  if (command === "create") {
    const kind = rest[0];
    const recordId = rest[1];
    return { argv: createArgs(kind, recordId, rest.slice(2)), short: true };
  }
  if (command === "edit") {
    return { argv: appendOption(["record", "update", ...tail], "id", id), short: true };
  }
  if (command === "start") {
    return { argv: recordActionArgs("start", id, tail), short: true };
  }
  if (command === "review") {
    return { argv: recordActionArgs("review", id, tail), short: true };
  }
  if (command === "complete") {
    return { argv: recordActionArgs("complete", id, tail), short: true };
  }
  if (command === "block") {
    return { argv: recordActionArgs("block", id, tail), short: true };
  }
  if (command === "cancel") {
    return { argv: recordActionArgs("cancel", id, tail), short: true };
  }
  return { argv: input, short: true };
}

function printJson(input) {
  process.stdout.write(`${JSON.stringify(input, null, 2)}\n`);
}

function formatDoctorOutput(data, verbose) {
  if (data.issues.length > 0 && !verbose) {
    const errorCount = data.issues.filter((issue) => issue.severity === "error").length;
    const warningCount = data.issues.filter((issue) => issue.severity === "warning").length;
    const summary = [];
    if (errorCount > 0) summary.push(`${errorCount} error${errorCount > 1 ? "s" : ""}`);
    if (warningCount > 0) summary.push(`${warningCount} warning${warningCount > 1 ? "s" : ""}`);
    return `doctor: ${summary.join(", ")}\n`;
  }
  if (verbose) {
    const lines = [`doctor: ${data.ok ? "OK" : "FAILED"}\n`];
    if (data.issues.length > 0) {
      lines.push(`\nIssues (${data.issues.length}):\n`);
      for (const issue of data.issues) {
        lines.push(`  [${issue.severity}] ${issue.code}: ${issue.message}\n`);
        if (issue.path) lines.push(`    ${issue.path}\n`);
      }
    }
    return lines.join("");
  }
  return "";
}

function formatCheckOutput(data, verbose) {
  if (!data.ok && !verbose) {
    return `check: ${data.issues.length} issue${data.issues.length > 1 ? "s" : ""} found\n`;
  }
  if (verbose) {
    const lines = [`check: ${data.ok ? "OK" : "FAILED"}\n`];
    if (data.issues.length > 0) {
      lines.push(`\nIssues (${data.issues.length}):\n`);
      for (const issue of data.issues) {
        lines.push(`  [${issue.severity}] ${issue.code}: ${issue.message}\n`);
        if (issue.path) lines.push(`    ${issue.path}\n`);
      }
    }
    return lines.join("");
  }
  return "";
}

export function main(argv, executableName = "project-ledger") {
  const normalized = normalizeShortCommand(argv, executableName);
  const jsonRequested = normalized.argv.includes("--json");
  let command = normalized.argv[0] ?? "help";
  try {
    const rootHelpRequested = command === "--help" || command === "-h";
    if (rootHelpRequested) command = "help";
    const { positionals, options } = parseArgs(rootHelpRequested ? [] : normalized.argv.slice(1));
    if (normalized.short) options.short = true;
    if (options.help) command = "help";
    const data = handle(command, positionals, options);
    const failed = commandShouldFail(command, options, data);

    const silent = options.silent ?? false;
    const verbose = options.verbose ?? false;

    if (command === "help") {
      process.stdout.write(`${data}\n`);
      return;
    }
    if (command === "render" && !options.json) {
      process.stdout.write(data.markdown);
      return;
    }
    if (jsonRequested || options.json) {
      printJson(createEnvelope({
        ok: !failed,
        command: `${normalized.short ? "pl" : "project-ledger"} ${command}`,
        data,
        error: failed ? { code: "project_ledger_check_failed", message: "Project Ledger check failed" } : null,
      }));
      if (failed) process.exitCode = 1;
      return;
    }

    if (command === "doctor") {
      const output = formatDoctorOutput(data, verbose);
      if (output) process.stdout.write(output);
      if (failed) process.exitCode = 1;
      return;
    }

    if (command === "check") {
      const output = formatCheckOutput(data, verbose);
      if (output) process.stdout.write(output);
      if (failed) process.exitCode = 1;
      return;
    }

    if (!silent) process.stdout.write(`${command} complete\n`);
    if (failed) process.exitCode = 1;
  } catch (error) {
    const cliError = errorFromUnknown(error);
    if (jsonRequested) {
      printJson(createEnvelope({
        ok: false,
        command: `${normalized.short ? "pl" : "project-ledger"} ${command}`,
        error: {
          code: cliError.code,
          message: cliError.message,
          details: cliError.details,
          next: cliError.next,
        },
      }));
    } else {
      process.stderr.write(`${cliError.message}\n`);
    }
    process.exitCode = cliError.exitCode;
  }
}
