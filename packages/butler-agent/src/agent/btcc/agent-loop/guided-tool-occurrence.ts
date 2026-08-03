import { digest, stableJson } from "../identity/index.ts";
import {
  normalizeGuidedToolCall,
  type NormalizedGuidedToolCall,
} from "../../tools/tool-support.ts";
import { parseToolCatalogId } from "../../tools/progressive-catalog.ts";

export function guidedToolOccurrence(input: {
  turnId: string;
  callIndex: number;
  providerCallId?: unknown;
  name: string;
  args: Record<string, unknown>;
}): {
  callId: string;
  providerCallId?: string;
  legacyProviderCallIds?: string[];
} {
  const providerCallId = normalizedProviderCallId(input.providerCallId);
  const normalized = guidedToolIdentityCall(input.name, input.args);
  const catalogId = guidedToolCatalogId(input.name, input.args);
  const identityFields = catalogId
    ? [catalogId, normalized.name, stableJson(normalized.args)]
    : [normalized.name, stableJson(normalized.args)];
  const callId = digest([
    providerCallId
      ? "btcc-guided-provider-tool-call.v2"
      : "btcc-guided-tool-call.v1",
    input.turnId,
    providerCallId ?? String(input.callIndex),
    ...identityFields,
  ].join("\0"));
  const legacyProviderCallIds = providerCallId
    ? legacyProviderCallIdsFor(input, providerCallId)
    : [];
  return {
    providerCallId,
    callId,
    ...(legacyProviderCallIds.length > 0
      ? { legacyProviderCallIds }
      : {}),
  };
}

function legacyProviderCallIdsFor(
  input: {
    turnId: string;
    name: string;
    args: Record<string, unknown>;
  },
  providerCallId: string,
): string[] {
  const candidates = [input.args];
  const summaryless = summarylessLegacyArguments(input);
  if (summaryless) candidates.push(summaryless);
  return [...new Set(candidates.map((args) => digest([
    "btcc-guided-provider-tool-call.v1",
    input.turnId,
    providerCallId,
    input.name,
    stableJson(args),
  ].join("\0"))))];
}

function summarylessLegacyArguments(input: {
  name: string;
  args: Record<string, unknown>;
}): Record<string, unknown> | undefined {
  if (input.name === "run_command" && Object.hasOwn(input.args, "summary")) {
    const { summary: _summary, ...args } = input.args;
    return args;
  }
  if (input.name !== "tool_call" || typeof input.args.id !== "string") {
    return undefined;
  }
  const catalogId = parseToolCatalogId(input.args.id);
  const nested = input.args.arguments;
  if (
    catalogId?.provider !== "native" ||
    catalogId.namespace !== null ||
    catalogId.name !== "run_command" ||
    !nested || typeof nested !== "object" || Array.isArray(nested) ||
    !Object.hasOwn(nested, "summary")
  ) {
    return undefined;
  }
  const { summary: _summary, ...summarylessNested } = nested as Record<string, unknown>;
  return { ...input.args, arguments: summarylessNested };
}

export function guidedToolIdentitySignature(
  toolName: string,
  args: Record<string, unknown>,
  catalogId?: string,
): string {
  const normalized = guidedToolIdentityCall(toolName, args);
  const effectiveCatalogId = catalogId ?? guidedToolCatalogId(toolName, args);
  return effectiveCatalogId
    ? stableJson([effectiveCatalogId, normalized.name, normalized.args])
    : stableJson([normalized.name, normalized.args]);
}

export function guidedToolCatalogId(
  toolName: string,
  args: Record<string, unknown>,
): string | undefined {
  if (typeof args.id !== "string" || !args.id.trim()) return undefined;
  if (toolName === "tool_call") return args.id.trim();
  return args.arguments && typeof args.arguments === "object" &&
    !Array.isArray(args.arguments)
    ? args.id.trim()
    : undefined;
}

export function guidedToolCatalogIdFromRawArguments(
  rawArguments: string,
): string | undefined {
  try {
    const value = JSON.parse(rawArguments) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.id === "string") {
      return guidedToolCatalogId("tool_call", record);
    }
    const callArgs = record.args;
    if (!callArgs || typeof callArgs !== "object" || Array.isArray(callArgs)) {
      return undefined;
    }
    return guidedToolCatalogId("tool_call", callArgs as Record<string, unknown>);
  } catch {
    return undefined;
  }
}

export function guidedToolIdentityCall(
  toolName: string,
  args: Record<string, unknown>,
): NormalizedGuidedToolCall {
  const normalized = normalizeGuidedToolCall({ toolName, args });
  if (normalized.name !== "run_command" || !Object.hasOwn(normalized.args, "summary")) {
    return normalized;
  }
  const { summary: _presentationOnly, ...executionArgs } = normalized.args;
  return { name: normalized.name, args: executionArgs };
}

function normalizedProviderCallId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
