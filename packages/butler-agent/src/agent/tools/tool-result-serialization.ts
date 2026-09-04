/** Provider result serialization is a shared tool concern, not a loop. */
import {
  structuredToolResultModelPreview,
  type ToolResultModelPreviewContext,
} from "./tool-result-model-preview.ts";

export const MAX_PROVIDER_TOOL_RESULT_BYTES = 50 * 1024;
const MAX_PROVIDER_TOOL_RESULT_LINES = 2_000;

export function createToolResultModelPreviewContext(): ToolResultModelPreviewContext {
  return {
    seenPublicWebEvidenceItemIds: new Set<string>(),
    seenProviderOverviews: new Set<string>(),
  };
}

/** Shares the bytes still available to this model request across one result batch. */
export function beginToolResultModelPreviewBatch(
  context: ToolResultModelPreviewContext,
  input: { maxBytes: number; resultCount: number },
): void {
  context.resultBatchBudget = {
    remainingBytes: Math.max(1, Math.trunc(input.maxBytes)),
    remainingResults: Math.max(1, Math.trunc(input.resultCount)),
  };
}

export function toolResultPayloadForProvider(
  payload: Record<string, unknown>,
  options?: { toolName?: string; context?: ToolResultModelPreviewContext },
): Record<string, unknown> {
  const toolName = options?.toolName;
  if (!toolName) return fitProviderPayload(payload, MAX_PROVIDER_TOOL_RESULT_BYTES);
  const preview = structuredToolResultModelPreview({
    toolName,
    output: payload.output,
    context: options.context,
  });
  const projected = preview ? { ...payload, output: preview } : payload;
  return fitProviderPayload(projected, claimResultBudget(options.context));
}

export function serializeToolResultPayloadForProvider(
  payload: Record<string, unknown>,
  options?: { toolName?: string; context?: ToolResultModelPreviewContext },
): string {
  return JSON.stringify(toolResultPayloadForProvider(payload, options));
}

function claimResultBudget(context?: ToolResultModelPreviewContext): number {
  const batch = context?.resultBatchBudget;
  if (!batch) return MAX_PROVIDER_TOOL_RESULT_BYTES;
  const allowance = Math.max(1, Math.floor(batch.remainingBytes / batch.remainingResults));
  batch.remainingResults = Math.max(0, batch.remainingResults - 1);
  const claimed = Math.min(MAX_PROVIDER_TOOL_RESULT_BYTES, allowance);
  batch.remainingBytes = Math.max(0, batch.remainingBytes - claimed);
  return claimed;
}

function fitProviderPayload(
  payload: Record<string, unknown>,
  maxBytes: number,
): Record<string, unknown> {
  const originalBytes = serializedBytes(payload);
  if (originalBytes <= maxBytes) return payload;
  for (const limits of [
    { stringChars: 4_800, arrayItems: 16 },
    { stringChars: 2_400, arrayItems: 8 },
    { stringChars: 1_200, arrayItems: 4 },
    { stringChars: 480, arrayItems: 2 },
    { stringChars: 160, arrayItems: 1 },
  ]) {
    const bounded = boundValue(payload, limits, 0) as Record<string, unknown>;
    const candidate = {
      ...bounded,
      model_preview: {
        truncated: true,
        original_provider_bytes: originalBytes,
        retrieval: "Use the result's cursor, source path, or artifact reader to continue.",
      },
    };
    if (serializedBytes(candidate) <= maxBytes) return candidate;
  }
  return {
    ok: payload.ok === true,
    ...(payload.error ? { error: boundValue(payload.error, { stringChars: 160, arrayItems: 1 }, 0) } : {}),
    model_preview: {
      truncated: true,
      original_provider_bytes: originalBytes,
      retrieval: "Use the result's cursor, source path, or artifact reader to continue.",
    },
  };
}

function boundValue(
  value: unknown,
  limits: { stringChars: number; arrayItems: number },
  depth: number,
): unknown {
  if (typeof value === "string") return boundString(value, limits.stringChars);
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (depth >= 5) return undefined;
  if (Array.isArray(value)) {
    return value.slice(0, limits.arrayItems)
      .map((entry) => boundValue(entry, limits, depth + 1))
      .filter((entry) => entry !== undefined);
  }
  if (!value || typeof value !== "object") return undefined;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const bounded = boundValue(entry, limits, depth + 1);
    if (bounded !== undefined) result[key] = bounded;
  }
  return result;
}

function boundString(value: string, maxChars: number): string {
  const lines = value.split("\n");
  const lineBounded = lines.length > MAX_PROVIDER_TOOL_RESULT_LINES
    ? `${lines.slice(0, MAX_PROVIDER_TOOL_RESULT_LINES).join("\n")}\n[remaining lines omitted]`
    : value;
  if (lineBounded.length <= maxChars) return lineBounded;
  const marker = "\n[content omitted; continue from the provided cursor or artifact]\n";
  const side = Math.max(1, Math.floor((maxChars - marker.length) / 2));
  return `${lineBounded.slice(0, side)}${marker}${lineBounded.slice(-side)}`;
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}
