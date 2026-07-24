import {
  isSpooledOperationOutput,
  stableJson,
  type OperationPayloadSource,
} from "../../core/index.ts";
import type { CommandExecutionSummary } from "../../operation-result/index.ts";

export function operationContent(output: unknown): {
  content: string;
  payloadSource?: Exclude<OperationPayloadSource, string>;
  executionSummary?: CommandExecutionSummary;
} {
  if (isSpooledOperationOutput(output)) {
    return {
      content: stableJson(output.summary),
      payloadSource: output.payloadSource,
      executionSummary: commandExecutionSummary(output.summary),
    };
  }
  return {
    content: typeof output === "string" ? output : stableJson(output),
  };
}

function commandExecutionSummary(value: unknown): CommandExecutionSummary {
  if (!value || typeof value !== "object") {
    throw new Error("Spooled command output is missing its execution summary");
  }
  const summary = value as Record<string, unknown>;
  const exitCode = summary.exitCode;
  const signal = summary.signal;
  if (
    !(typeof exitCode === "number" || exitCode === null) ||
    typeof summary.timedOut !== "boolean" ||
    !(typeof signal === "string" || signal === null)
  ) {
    throw new Error("Spooled command output has an invalid execution summary");
  }
  return {
    kind: "command_execution",
    exitCode,
    timedOut: summary.timedOut,
    signal,
  };
}

export function assertActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error("BTCC operation aborted");
}

export function sameRef(
  left: { id: string; sha256: string },
  right: { id: string; sha256: string },
): boolean {
  return left.id === right.id && left.sha256 === right.sha256;
}
