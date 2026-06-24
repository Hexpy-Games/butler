import type { ToolCapabilityCategory, ToolCatalogProvider } from "../types.ts";

export type BridgeToolAction = "search" | "describe" | "invoke";
export type BridgeToolOutcome = "ok" | "disabled" | "denied" | "invalid" | "unknown" | "error";

export interface BridgeDisabledRecovery {
  reason: string;
  alternatives: string[];
  next_action: string;
}

export interface BridgeToolAuditEvent {
  schema: "butler.bridge-tool-audit.v1";
  action: BridgeToolAction;
  tool_name: "tool_search" | "tool_describe" | "tool_call";
  outcome: BridgeToolOutcome;
  request: Record<string, unknown>;
  target?: {
    id: string;
    provider: ToolCatalogProvider | "unknown";
    affordance?: string;
  };
  result?: Record<string, unknown>;
  error?: {
    code: string;
    recoverable: boolean;
    operational_failure: boolean;
  };
}

const BRIDGE_TOOL_NAMES = new Set(["tool_search", "tool_describe", "tool_call"]);
const DENIED_ERROR_CODES = new Set([
  "forbidden_bridge_target",
  "invalid_mcp_affordance",
  "unsupported_tool_affordance",
]);

export function isBridgeToolName(name: string): name is BridgeToolAuditEvent["tool_name"] {
  return BRIDGE_TOOL_NAMES.has(name);
}

export function redactedBridgeToolAuditArgs(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (toolName === "tool_search") {
    return {
      provider: stringOrNull(args.provider),
      category: stringOrNull(args.category),
      query_present: hasText(args.query),
      capability_present: hasText(args.capability),
      include_disabled: args.include_disabled === true,
      limit: typeof args.limit === "number" ? Math.floor(args.limit) : null,
    };
  }
  if (toolName === "tool_describe") {
    return {
      ids: stringArray(args.ids).slice(0, 20),
      id_count: stringArray(args.ids).length,
    };
  }
  if (toolName === "tool_call") {
    return {
      id: stringOrNull(args.id),
      arguments: "[redacted]",
    };
  }
  return args;
}

export function redactedBridgeToolAuditResult(
  toolName: string,
  result: unknown,
): unknown {
  const event = bridgeToolAuditEvent(toolName, {}, result);
  return event?.result ?? result;
}

export function bridgeToolAuditEvent(
  toolName: string,
  args: Record<string, unknown>,
  result: unknown,
): BridgeToolAuditEvent | null {
  if (!isBridgeToolName(toolName)) return null;
  const action = bridgeAction(toolName);
  const summary = bridgeResultSummary(toolName, result);
  return {
    schema: "butler.bridge-tool-audit.v1",
    action,
    tool_name: toolName,
    outcome: summary.outcome,
    request: redactedBridgeToolAuditArgs(toolName, args),
    ...summary.details,
  };
}

export function disabledToolRecovery(input: {
  id: string;
  provider?: string | null;
  category?: ToolCapabilityCategory | string | null;
  reason?: string | null;
}): BridgeDisabledRecovery {
  const reason = input.reason?.trim() || "Tool is disabled.";
  const alternatives = recoveryAlternatives(input);
  return {
    reason,
    alternatives,
    next_action: [
      "Treat this as a recoverable tool-selection result, not an app failure.",
      alternatives.length > 0
        ? "Choose an enabled alternative when it can satisfy the same goal."
        : "Call tool_search to inspect currently enabled tools before retrying.",
      "If this exact disabled capability is required, explain the limitation and continue with available evidence.",
    ].join(" "),
  };
}

function bridgeAction(toolName: BridgeToolAuditEvent["tool_name"]): BridgeToolAction {
  if (toolName === "tool_search") return "search";
  if (toolName === "tool_describe") return "describe";
  return "invoke";
}

function bridgeResultSummary(
  toolName: BridgeToolAuditEvent["tool_name"],
  result: unknown,
): {
  outcome: BridgeToolOutcome;
  details: Omit<BridgeToolAuditEvent, "schema" | "action" | "tool_name" | "outcome" | "request">;
} {
  const record = objectRecord(result);
  const error = objectRecord(record?.error);
  if (error) {
    const code = typeof error.code === "string" ? error.code : "tool_error";
    const outcome = outcomeFromErrorCode(code);
    return {
      outcome,
      details: {
        target: targetFromRecord(record, error),
        result: { ok: false, code },
        error: {
          code,
          recoverable: error.recoverable !== false,
          operational_failure: code === "underlying_tool_error",
        },
      },
    };
  }
  const stringErrorCode = stringErrorAuditCode(toolName, record);
  if (stringErrorCode) {
    return {
      outcome: outcomeFromErrorCode(stringErrorCode),
      details: {
        target: targetFromRecord(record, null),
        result: { ok: false, code: stringErrorCode },
        error: {
          code: stringErrorCode,
          recoverable: false,
          operational_failure: stringErrorCode === "underlying_tool_error",
        },
      },
    };
  }
  if (toolName === "tool_search") return searchSummary(record);
  if (toolName === "tool_describe") return describeSummary(record);
  return callSummary(record);
}

function stringErrorAuditCode(
  toolName: BridgeToolAuditEvent["tool_name"],
  record: Record<string, unknown> | null,
): string | null {
  if (toolName !== "tool_call") return null;
  if (record?.ok !== false || typeof record.error !== "string") return null;
  return objectRecord(record.bridge_invocation) ? "underlying_tool_error" : "tool_error";
}

function searchSummary(record: Record<string, unknown> | null): ReturnType<typeof bridgeResultSummary> {
  const results = Array.isArray(record?.results) ? record.results : [];
  const enabled = results.filter((item) => objectRecord(item)?.enabled === true).length;
  return {
    outcome: record?.ok === false ? "error" : "ok",
    details: {
      result: {
        ok: record?.ok !== false,
        result_count: results.length,
        enabled_count: enabled,
        disabled_count: results.length - enabled,
      },
    },
  };
}

function describeSummary(record: Record<string, unknown> | null): ReturnType<typeof bridgeResultSummary> {
  const descriptions = Array.isArray(record?.descriptions) ? record.descriptions : [];
  const missing = Array.isArray(record?.missing) ? record.missing : [];
  const disabled = descriptions.filter((item) => objectRecord(item)?.enabled === false).length;
  return {
    outcome: record?.ok === false ? "unknown" : "ok",
    details: {
      result: {
        ok: record?.ok !== false,
        described_count: descriptions.length,
        disabled_count: disabled,
        missing_count: missing.length,
      },
    },
  };
}

function callSummary(record: Record<string, unknown> | null): ReturnType<typeof bridgeResultSummary> {
  return {
    outcome: record?.ok === false ? "error" : "ok",
    details: {
      target: targetFromRecord(record, null),
      result: { ok: record?.ok !== false },
    },
  };
}

function outcomeFromErrorCode(code: string): BridgeToolOutcome {
  if (code === "disabled_tool") return "disabled";
  if (code === "unknown_tool_catalog_id") return "unknown";
  if (code === "invalid_tool_catalog_id" || code === "invalid_tool_arguments" || code === "tool_not_described") return "invalid";
  if (DENIED_ERROR_CODES.has(code)) return "denied";
  return "error";
}

function targetFromRecord(
  record: Record<string, unknown> | null,
  error: Record<string, unknown> | null,
): BridgeToolAuditEvent["target"] | undefined {
  const bridgeInvocation = objectRecord(record?.bridge_invocation);
  const id = stringOrNull(bridgeInvocation?.id) ?? stringOrNull(error?.id);
  if (!id) return undefined;
  return {
    id,
    provider: providerOrUnknown(bridgeInvocation?.provider),
    affordance: stringOrNull(bridgeInvocation?.affordance) ?? undefined,
  };
}

function recoveryAlternatives(input: {
  id: string;
  provider?: string | null;
  category?: ToolCapabilityCategory | string | null;
}): string[] {
  const alternatives = ["tool_search"];
  if (input.provider === "native" && input.category === "search") alternatives.push("web_read");
  if (input.provider === "mcp") alternatives.push("list_mcp_capabilities");
  if (input.provider === "plugin") alternatives.push("tool_describe");
  return [...new Set(alternatives)];
}

function providerOrUnknown(value: unknown): ToolCatalogProvider | "unknown" {
  if (value === "native" || value === "mcp" || value === "plugin") return value;
  return "unknown";
}

function hasText(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
