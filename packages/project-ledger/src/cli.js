import { parseArgs } from "./args.js";
import { commandShouldFail, handle } from "./commands.js";
import { createEnvelope, errorFromUnknown } from "./errors.js";

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

export function main(argv) {
  const jsonRequested = argv.includes("--json");
  let command = argv[0] ?? "help";
  try {
    const rootHelpRequested = command === "--help" || command === "-h";
    if (rootHelpRequested) command = "help";
    const { positionals, options } = parseArgs(rootHelpRequested ? [] : argv.slice(1));
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
        command: `project-ledger ${command}`,
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
        command: `project-ledger ${command}`,
        error: {
          code: cliError.code,
          message: cliError.message,
          details: cliError.details,
        },
      }));
    } else {
      process.stderr.write(`${cliError.message}\n`);
    }
    process.exitCode = cliError.exitCode;
  }
}
