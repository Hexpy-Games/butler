import {
  isValidationCommand,
  validationCommandKey,
} from "../../../tools/run-command/run_command/validation-command.ts";
import type { ToolAuditEntry } from "../output/tool-types.ts";

export interface UnresolvedValidationFailure {
  command: string;
  exitCode: number | null;
  timedOut: boolean;
}

interface CommandResult {
  command: string;
  exitCode: number | null;
  timedOut: boolean;
}

export function unresolvedValidationFailureFromAudit(
  audit: ToolAuditEntry[],
): UnresolvedValidationFailure | null {
  const latestByCommand = new Map<string, UnresolvedValidationFailure | null>();
  const orderedKeys: string[] = [];
  for (const entry of audit) {
    const result = commandResultFromAuditEntry(entry);
    if (!result || !isValidationCommand(result.command)) continue;
    const key = validationCommandKey(result.command);
    if (!latestByCommand.has(key)) orderedKeys.push(key);
    latestByCommand.set(key, commandSucceeded(result) ? null : {
      command: result.command,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
    });
  }
  for (const key of orderedKeys.reverse()) {
    const failure = latestByCommand.get(key);
    if (failure) return failure;
  }
  return null;
}

export function validationFailureContinuationPrompt(input: {
  objective: string;
  previousAnswer: string;
  failure: UnresolvedValidationFailure;
}): string {
  return [
    "## Validation Failure Continuation",
    "A validation command failed and there is no later passing run for the same validation command.",
    "",
    "Failed validation:",
    `- command: ${input.failure.command}`,
    `- exit_code: ${input.failure.exitCode ?? "unknown"}`,
    `- timed_out: ${input.failure.timedOut ? "yes" : "no"}`,
    "",
    "Objective:",
    compact(input.objective, 600),
    "",
    "Previous draft:",
    compact(input.previousAnswer, 900),
    "",
    "Next action:",
    "- Do not deliver a final completion report yet.",
    "- Inspect the failed validation evidence using existing artifacts or a small targeted command.",
    "- Fix the cause when it is inside the workspace.",
    "- Re-run the same validation command or an equivalent stricter validation command.",
    "- If the blocker is external or cannot be fixed in this turn, leave the WorkStream recoverable and report the exact remaining validation failure.",
  ].join("\n");
}

function commandSucceeded(result: CommandResult): boolean {
  return result.exitCode === 0 && !result.timedOut;
}

function commandResultFromAuditEntry(entry: ToolAuditEntry): CommandResult | null {
  if (entry.name !== "run_command" || !entry.result || typeof entry.result !== "object") return null;
  const record = entry.result as Record<string, unknown>;
  const command = typeof record.command === "string"
    ? record.command
    : typeof entry.args.command === "string"
    ? entry.args.command
    : "";
  if (!command.trim()) return null;
  const exitCode = typeof record.exit_code === "number" || record.exit_code === null
    ? record.exit_code
    : null;
  const timedOut = record.timed_out === true;
  return { command, exitCode, timedOut };
}

function compact(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 1).trimEnd()}...`;
}
