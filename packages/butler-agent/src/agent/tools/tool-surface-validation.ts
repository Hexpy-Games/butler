import type {
  ToolSurfaceConfiguredCapabilities,
  ToolSurfaceMetadata,
  ToolSurfaceProviderCapabilities,
  ToolSurfaceToolName,
  ToolSurfaceUserApproval,
} from "./tool-surface-types.ts";

const NATURAL_LANGUAGE_INPUT_KEYS = new Set([
  "input",
  "inputText",
  "message",
  "messages",
  "naturalLanguagePrompt",
  "naturalLanguageText",
  "prompt",
  "promptText",
  "text",
  "userText",
]);

const NATURAL_LANGUAGE_KEY_SEGMENTS = new Set(["input", "message", "prompt", "text"]);

export class ToolSurfaceStructuredInputError extends Error {
  override name = "ToolSurfaceStructuredInputError";
}

export function assertNoNaturalLanguageInputFields(value: unknown, surface: string): void {
  visitStructuredValue(value, surface);
}

export function uniqueNonEmptyStrings(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter((value) => value.length > 0))];
}

export function mergeToolNames(...values: readonly (readonly ToolSurfaceToolName[] | undefined)[]): ToolSurfaceToolName[] {
  return uniqueNonEmptyStrings(values.flatMap((value) => value ?? []));
}

export function normalizedDisabledReasons(input: {
  providerCapabilities?: ToolSurfaceProviderCapabilities;
  disabledReason?: string;
  disabledReasons?: readonly string[];
}): string[] {
  const reasons = uniqueNonEmptyStrings([
    input.disabledReason ?? "",
    ...(input.disabledReasons ?? []),
  ]);
  if (input.providerCapabilities?.supportsToolCalls === false) {
    reasons.push("provider_tool_calls_disabled");
  }
  return uniqueNonEmptyStrings(reasons);
}

export function cloneConfiguredCapabilities(
  capabilities: ToolSurfaceConfiguredCapabilities | undefined,
): ToolSurfaceConfiguredCapabilities | undefined {
  if (capabilities === undefined) return undefined;
  assertNoNaturalLanguageInputFields(capabilities, "ToolSurfaceConfiguredCapabilities");
  return {
    ...capabilities,
    toolNames: mergeToolNames(capabilities.toolNames),
  };
}

export function cloneUserApprovals(approvals: readonly ToolSurfaceUserApproval[] | undefined): ToolSurfaceUserApproval[] {
  const cloned = approvals?.map((approval) => ({ ...approval, target: { ...approval.target } })) ?? [];
  assertNoNaturalLanguageInputFields(cloned, "ToolSurfaceUserApproval");
  return cloned;
}

export function cloneProviderCapabilities(
  capabilities: ToolSurfaceProviderCapabilities | undefined,
): ToolSurfaceProviderCapabilities | undefined {
  if (capabilities === undefined) return undefined;
  assertNoNaturalLanguageInputFields(capabilities, "ToolSurfaceProviderCapabilities");
  return { ...capabilities };
}

export function cloneStructuredMetadata(
  metadata: ToolSurfaceMetadata | undefined,
  surface: string,
): ToolSurfaceMetadata | undefined {
  if (metadata === undefined) return undefined;
  assertNoNaturalLanguageInputFields(metadata, surface);
  return { ...metadata };
}

function visitStructuredValue(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => visitStructuredValue(item, `${path}[${index}]`));
    return;
  }

  if (!value || typeof value !== "object") return;

  for (const [key, child] of Object.entries(value)) {
    if (isNaturalLanguageInputKey(key)) {
      throw new ToolSurfaceStructuredInputError(
        `${path} does not accept natural-language prompt text field: ${key}`,
      );
    }
    visitStructuredValue(child, `${path}.${key}`);
  }
}

function isNaturalLanguageInputKey(key: string): boolean {
  if (NATURAL_LANGUAGE_INPUT_KEYS.has(key)) return true;
  const segmentedKey = key.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").toLocaleLowerCase("en-US");
  return segmentedKey
    .split(/[._-]+/u)
    .some((segment) => NATURAL_LANGUAGE_KEY_SEGMENTS.has(segment));
}
