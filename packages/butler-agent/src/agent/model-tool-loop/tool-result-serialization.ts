import {
  structuredToolResultModelPreview,
  type ToolResultModelPreviewContext,
} from "./tool-result-model-preview.ts";

export function createToolResultModelPreviewContext(): ToolResultModelPreviewContext {
  return {
    seenPublicWebEvidenceItemIds: new Set<string>(),
    seenProviderOverviews: new Set<string>(),
  };
}

export function toolResultPayloadForProvider(
  payload: Record<string, unknown>,
  options?: {
    toolName?: string;
    context?: ToolResultModelPreviewContext;
  },
): Record<string, unknown> {
  const toolName = options?.toolName;
  if (!toolName || !options?.context) return payload;
  if (toolName === "web_search" || toolName === "web_read") {
    return projectWebToolPayload(payload, toolName, options.context);
  }
  if (toolName === "run_work_block") {
    const projectedOutput = projectNestedWebResults(
      payload.output,
      options.context,
    );
    return projectedOutput === payload.output
      ? payload
      : { ...payload, output: projectedOutput };
  }
  return payload;
}

export function serializeToolResultPayloadForProvider(
  payload: Record<string, unknown>,
  options?: {
    toolName?: string;
    context?: ToolResultModelPreviewContext;
  },
): string {
  return JSON.stringify(toolResultPayloadForProvider(payload, options));
}

function projectWebToolPayload(
  payload: Record<string, unknown>,
  toolName: "web_search" | "web_read",
  context: ToolResultModelPreviewContext,
): Record<string, unknown> {
  if (payload.output === undefined) return payload;
  const preview = structuredToolResultModelPreview({
    toolName,
    output: payload.output,
    context,
  });
  return preview ? { ...payload, output: preview } : payload;
}

function projectNestedWebResults(
  value: unknown,
  context: ToolResultModelPreviewContext,
): unknown {
  if (!isRecord(value)) return value;
  if (Array.isArray(value.results)) {
    let changed = false;
    const results = value.results.map((entry) => {
      const projected = projectWorkBlockResult(entry, context);
      if (projected !== entry) changed = true;
      return projected;
    });
    return changed ? { ...value, results } : value;
  }
  for (const key of ["output", "result"] as const) {
    const projected = projectNestedWebResults(value[key], context);
    if (projected !== value[key]) return { ...value, [key]: projected };
  }
  return value;
}

function projectWorkBlockResult(
  value: unknown,
  context: ToolResultModelPreviewContext,
): unknown {
  if (!isRecord(value) || typeof value.name !== "string") return value;
  if (value.name !== "web_search" && value.name !== "web_read") {
    if (value.name !== "run_work_block") return value;
    for (const key of ["result", "output"] as const) {
      const projected = projectNestedWebResults(value[key], context);
      if (projected !== value[key]) return { ...value, [key]: projected };
    }
    return value;
  }
  for (const key of ["result", "output"] as const) {
    if (value[key] === undefined) continue;
    const preview = structuredToolResultModelPreview({
      toolName: value.name,
      output: value[key],
      context,
    });
    return preview ? { ...value, [key]: preview } : value;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
