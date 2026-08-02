import type { BtccTurnProgressObserver } from "../contracts.ts";
import { digest } from "../identity/index.ts";
import { publicToolTitle } from "../projection/index.ts";

export function rememberDescribedTools(
  toolName: string,
  result: unknown,
  described: Set<string>,
): void {
  if (toolName !== "tool_describe" || !result || typeof result !== "object") return;
  const descriptions = (result as { descriptions?: unknown }).descriptions;
  if (!Array.isArray(descriptions)) return;
  for (const value of descriptions) {
    if (!value || typeof value !== "object") continue;
    const id = (value as { id?: unknown }).id;
    if (typeof id === "string" && id) described.add(id);
  }
}

export async function publishOperation(
  progress: BtccTurnProgressObserver | undefined,
  input: {
    turnId: string;
    activityId: string;
    requestId: string;
    toolName: string;
    status: "started" | "completed" | "failed" | "cancelled";
    resultJson?: string;
  },
): Promise<void> {
  if (!progress?.operationChanged) return;
  try {
    await progress.operationChanged({
      turnId: input.turnId,
      semanticState: "admitted",
      activityId: input.activityId,
      requestId: input.requestId,
      publicTitle: publicToolTitle(input.toolName),
      capabilityRef: input.toolName,
      status: input.status,
      ...(input.resultJson
        ? {
            resultRef: {
              id: digest(`btcc-guided-tool-result.v1\0${digest(input.resultJson)}`),
              sha256: digest(input.resultJson),
            },
            byteLength: Buffer.byteLength(input.resultJson),
          }
        : {}),
    });
  } catch {
    // Public progress cannot veto tool execution.
  }
}

export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return JSON.stringify({ unavailable: true });
  }
}

export function toolResultSucceeded(result: unknown): boolean {
  if (!result || typeof result !== "object" || Array.isArray(result)) return true;
  const record = result as Record<string, unknown>;
  if (record.ok === false || record.timed_out === true) return false;
  return typeof record.exit_code !== "number" || record.exit_code === 0;
}

export function ordinaryToolError(
  toolName: string,
  error: unknown,
): Record<string, unknown> {
  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    error: {
      code: "tool_error",
      message: `${toolName} could not complete: ${message.slice(0, 1_000)}`,
    },
  };
}

export function unauthorizedToolResult(toolName: string): Record<string, unknown> {
  return {
    ok: false,
    error: {
      code: "tool_not_authorized",
      message: `${toolName} is not available for this Turn. Use an available tool or continue with known facts.`,
    },
  };
}
