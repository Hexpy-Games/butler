import type { McpSecretInput, McpServerUpsertRequest } from "./integration-contract.ts";
import type { UpdateSettingsRequest, WebSearchSettingsUpdate, WorkerModelRule } from "./settings-contract.ts";

const UPDATE_SETTINGS_KEYS = new Set([
  "server_url",
  "language",
  "timezone",
  "model",
  "reasoning_effort",
  "consolidation_model",
  "consolidation_reasoning_effort",
  "context_window_tokens",
  "worker_model_rules",
  "access_mode",
  "plan_mode_default",
  "follow_up_behavior",
  "multiline_send_behavior",
  "appearance_theme",
  "main_screen_theme",
  "main_screen_theme_preset",
  "main_screen_theme_custom_colors",
  "translucent_sidebar",
  "diagnostics_enabled",
  "desktop_notifications",
  "desktop_tray_enabled",
  "web_search",
  "default_project_folder_selection_token",
]);

const MCP_SERVER_UPSERT_KEYS = new Set([
  "id",
  "display_name",
  "enabled",
  "transport",
  "command",
  "args",
  "cwd",
  "url",
  "env",
  "headers",
]);

export function isMcpServerUpsertRequest(
  value: unknown,
): value is McpServerUpsertRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  if (!Object.keys(input).every((key) => MCP_SERVER_UPSERT_KEYS.has(key)))
    return false;
  if ("id" in input && typeof input.id !== "string") return false;
  if ("display_name" in input && typeof input.display_name !== "string")
    return false;
  if ("enabled" in input && typeof input.enabled !== "boolean") return false;
  if (
    "transport" in input &&
    input.transport !== "stdio" &&
    input.transport !== "http" &&
    input.transport !== "sse"
  ) {
    return false;
  }
  if ("command" in input && typeof input.command !== "string") return false;
  if ("cwd" in input && typeof input.cwd !== "string") return false;
  if ("url" in input && typeof input.url !== "string") return false;
  if (
    "args" in input &&
    (!Array.isArray(input.args) ||
      !input.args.every((item) => typeof item === "string"))
  ) {
    return false;
  }
  if ("env" in input && !isMcpSecretInputArray(input.env)) return false;
  if ("headers" in input && !isMcpSecretInputArray(input.headers)) return false;
  return true;
}

const WORKER_MODEL_RULE_KEYS = new Set([
  "id",
  "label",
  "condition",
  "model",
  "reasoning_effort",
  "enabled",
]);

export function isUpdateSettingsRequest(
  value: unknown,
): value is UpdateSettingsRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  if (!Object.keys(input).every((key) => UPDATE_SETTINGS_KEYS.has(key)))
    return false;
  if (
    "context_window_tokens" in input &&
    (typeof input.context_window_tokens !== "number" ||
      !Number.isFinite(input.context_window_tokens) ||
      input.context_window_tokens <= 0)
  ) {
    return false;
  }
  if ("language" in input && input.language !== "en" && input.language !== "ko")
    return false;
  if ("timezone" in input && !isIanaTimezone(input.timezone)) return false;
  if (
    "consolidation_model" in input &&
    typeof input.consolidation_model !== "string"
  )
    return false;
  if (
    "consolidation_reasoning_effort" in input &&
    !["none", "low", "medium", "high", "xhigh"].includes(
      String(input.consolidation_reasoning_effort),
    )
  )
    return false;
  if (
    "worker_model_rules" in input &&
    !isWorkerModelRuleList(input.worker_model_rules)
  )
    return false;
  if (
    "desktop_notifications" in input &&
    !isDesktopNotificationSettingsUpdate(input.desktop_notifications)
  )
    return false;
  if (
    "desktop_tray_enabled" in input &&
    typeof input.desktop_tray_enabled !== "boolean"
  )
    return false;
  if ("web_search" in input && !isWebSearchSettingsUpdate(input.web_search))
    return false;
  return true;
}

function isDesktopNotificationSettingsUpdate(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const input = value as Record<string, unknown>;
  return Object.keys(input).every((key) =>
    ["enabled", "assistant_messages", "task_completions"].includes(key) &&
    typeof input[key] === "boolean",
  );
}

function isWebSearchSettingsUpdate(
  value: unknown,
): value is WebSearchSettingsUpdate {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  const allowed = new Set([
    "provider",
    "reader_backend",
    "api_key",
    "planning_enabled",
    "planning_default_depth",
  ]);
  if (!Object.keys(input).every((key) => allowed.has(key))) return false;
  if (
    "provider" in input &&
    ![
      "duckduckgo-html",
      "auto",
      "brave",
      "tavily",
      "openai-web-search",
      "codex-subscription-web-search",
      "disabled",
    ].includes(String(input.provider))
  )
    return false;
  if (
    "reader_backend" in input &&
    !["lightweight", "auto", "lightpanda", "jina-hosted", "disabled"].includes(
      String(input.reader_backend),
    )
  )
    return false;
  if ("api_key" in input && typeof input.api_key !== "string") return false;
  if (
    "planning_enabled" in input &&
    typeof input.planning_enabled !== "boolean"
  )
    return false;
  if (
    "planning_default_depth" in input &&
    !["quick", "balanced", "deep"].includes(
      String(input.planning_default_depth),
    )
  )
    return false;
  return true;
}

function isMcpSecretInputArray(value: unknown): value is McpSecretInput[] {
  return (
    Array.isArray(value) &&
    value.every((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item))
        return false;
      const input = item as Record<string, unknown>;
      return (
        typeof input.key === "string" &&
        typeof input.value === "string" &&
        (input.source === "literal" ||
          input.source === "env" ||
          input.source === "file")
      );
    })
  );
}

function isIanaTimezone(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim() || value.length > 96) {
    return false;
  }
  try {
    Intl.DateTimeFormat("en-US", { timeZone: value.trim() });
    return true;
  } catch {
    return false;
  }
}

function isWorkerModelRuleList(value: unknown): value is WorkerModelRule[] {
  if (!Array.isArray(value)) return false;
  return value.every((rule) => {
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) return false;
    const input = rule as Record<string, unknown>;
    if (!Object.keys(input).every((key) => WORKER_MODEL_RULE_KEYS.has(key)))
      return false;
    if ("id" in input && typeof input.id !== "string") return false;
    if ("label" in input && typeof input.label !== "string") return false;
    if ("condition" in input && typeof input.condition !== "string")
      return false;
    if ("model" in input && typeof input.model !== "string") return false;
    if ("enabled" in input && typeof input.enabled !== "boolean") return false;
    if (
      "reasoning_effort" in input &&
      !["none", "low", "medium", "high", "xhigh"].includes(
        String(input.reasoning_effort),
      )
    ) {
      return false;
    }
    return true;
  });
}
