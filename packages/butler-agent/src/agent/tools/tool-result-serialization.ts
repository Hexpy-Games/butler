/** Provider result serialization is a shared tool concern, not a loop. */
import {
  structuredToolResultModelProjection,
  type ToolResultModelPreviewContext,
} from "./tool-result-model-preview.ts";
import { fitExactOperationResultPage, fitToolArtifactPage } from "./artifact-result-preview.ts";

export const MAX_PROVIDER_TOOL_RESULT_BYTES = 50 * 1024;
const MAX_PROVIDER_TOOL_RESULT_LINES = 2_000;

export type ToolResultExactReadReference = {
  capability: "read_operation_results";
  arguments: {
    result_ref: string;
    sha256: string;
    revision: number | null;
    work_id: string | null;
    offset: number;
    length: number;
  };
  total_bytes: number;
};

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
  options?: {
    toolName?: string;
    context?: ToolResultModelPreviewContext;
    exactReadReference?: ToolResultExactReadReference;
  },
): Record<string, unknown> {
  const toolName = options?.toolName;
  if (!toolName) return fitProviderPayload(payload, MAX_PROVIDER_TOOL_RESULT_BYTES);
  const projection = structuredToolResultModelProjection({
    toolName,
    output: payload.output,
    context: options.context,
  });
  const preview = projection.preview;
  const exactReadReference = RESULT_READER_TOOLS.has(toolName)
    ? undefined
    : options?.exactReadReference;
  const projected = preview ? { ...payload, output: preview } : payload;
  const projectedWithReference = preview && exactReadReference &&
      (projection.partial || previewSignalsPartial(preview))
    ? {
        ...projected,
        model_preview: modelPreviewMetadata(
          serializedBytes(payload),
          exactReadReference,
        ),
      }
    : projected;
  const budget = claimResultBudget(options.context);
  if (toolName === "read_operation_results") {
    return fitExactOperationResultPage(projectedWithReference, budget);
  }
  if (toolName === "read_tool_output_artifact" || toolName === "read_tool_evidence_artifact") {
    return fitToolArtifactPage(projectedWithReference, budget);
  }
  return fitProviderPayload(projectedWithReference, budget, {
    toolName,
    exactReadReference,
  });
}

const RESULT_READER_TOOLS = new Set([
  "read_operation_results",
  "read_tool_output_artifact",
  "read_tool_evidence_artifact",
]);

export function serializeToolResultPayloadForProvider(
  payload: Record<string, unknown>,
  options?: {
    toolName?: string;
    context?: ToolResultModelPreviewContext;
    exactReadReference?: ToolResultExactReadReference;
  },
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
  options?: {
    toolName?: string;
    exactReadReference?: ToolResultExactReadReference;
  },
): Record<string, unknown> {
  const originalBytes = serializedBytes(payload);
  if (originalBytes <= maxBytes) return payload;
  const modelPreview = modelPreviewMetadata(
    originalBytes,
    options?.exactReadReference,
  );
  const output = record(payload.output);
  const artifact = record(output?.butler_tool_artifact);
  if (artifact && typeof artifact.path === "string") {
    modelPreview.artifact_read = {
      capability: "read_tool_output_artifact",
      arguments: { path: artifact.path, offset_chars: 0, stream: "both" },
    };
  }
  for (const limits of [
    { stringChars: 4_800, arrayItems: 16 },
    { stringChars: 2_400, arrayItems: 8 },
    { stringChars: 1_200, arrayItems: 4 },
    { stringChars: 480, arrayItems: 2 },
    { stringChars: 160, arrayItems: 1 },
  ]) {
    const bounded = boundValue(payload, limits, 0) as Record<string, unknown>;
    const candidate = mergeStructuralOutcome(bounded, {
      ...structuralOutcome(payload, options?.toolName),
      model_preview: modelPreview,
    });
    if (serializedBytes(candidate) <= maxBytes) return candidate;
  }
  return {
    ...structuralOutcome(payload, options?.toolName),
    model_preview: modelPreview,
  };
}

function modelPreviewMetadata(
  originalBytes: number,
  exactReadReference?: ToolResultExactReadReference,
): Record<string, unknown> {
  return {
    truncated: true,
    completeness: "partial",
    original_provider_bytes: originalBytes,
    ...(exactReadReference ? { exact_read: exactReadReference } : {}),
  };
}

function previewSignalsPartial(value: unknown): boolean {
  if (typeof value === "string") {
    return value.includes("[middle omitted]") ||
      value.includes("[content omitted") ||
      value.includes("[preview cut");
  }
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(previewSignalsPartial);
  const object = value as Record<string, unknown>;
  if (
    object.preview_content_truncated === true ||
    object.truncated_by_lines === true ||
    object.truncated_by_tokens === true ||
    object.content_has_more === true ||
    object.markdown_truncated === true
  ) return true;
  return Object.values(object).some(previewSignalsPartial);
}

function mergeStructuralOutcome(
  payload: Record<string, unknown>,
  structural: Record<string, unknown>,
): Record<string, unknown> {
  const payloadOutput = record(payload.output);
  const structuralOutput = record(structural.output);
  return {
    ...payload,
    ...structural,
    ...(payloadOutput || structuralOutput
      ? { output: { ...payloadOutput, ...structuralOutput } }
      : {}),
  };
}

/** Preserve terminal and Work-control facts independently of payload preview bytes. */
function structuralOutcome(
  payload: Record<string, unknown>,
  toolName?: string,
): Record<string, unknown> {
  const output = record(payload.output);
  const error = errorIdentity(payload.error ?? output?.error);
  const work = record(output?.work);
  return compactUndefined({
    ok: typeof payload.ok === "boolean" ? payload.ok : undefined,
    error,
    ...(output
      ? {
          output: compactUndefined({
            tool_name: toolName,
            ok: typeof output?.ok === "boolean" ? output.ok : undefined,
            error: errorIdentity(output?.error),
            ...controlFacts(output),
            ...(output.butler_tool_artifact ? {
              butler_tool_artifact: output.butler_tool_artifact,
              output_presentation: { ...record(output.output_presentation), truncated: true },
            } : {}),
            ...(work ? { work } : {}),
          }),
        }
      : {}),
  });
}

const CONTROL_FACT_KEYS = [
  "status",
  "state",
  "outcome",
  "authority_pending",
  "approval_status",
  "request_status",
  "execution_status",
  "executed",
  "not_executed",
  "pending",
  "queued",
  "exit_code",
  "timed_out",
  "signal",
  "error_code",
  "current_stage",
  "action_key",
  "action_status",
  "next_action",
] as const;

function controlFacts(output: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(CONTROL_FACT_KEYS.flatMap((key) => {
    const value = output[key];
    return value === null || typeof value === "string" ||
      typeof value === "boolean" || typeof value === "number"
      ? [[key, value]]
      : [];
  }));
}

function errorIdentity(errorValue: unknown): Record<string, unknown> | string | undefined {
  if (typeof errorValue === "string") return boundString(errorValue, 480);
  const error = record(errorValue);
  if (!error) return undefined;
  return compactUndefined({
    code: error.code,
    name: error.name,
    status: error.status,
    current_stage: error.current_stage,
    requested_action: error.requested_action,
    unmet_guard: error.unmet_guard,
    next_action: error.next_action,
    message: typeof error.message === "string"
      ? boundString(error.message, 480)
      : undefined,
  });
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

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function compactUndefined(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );
}
