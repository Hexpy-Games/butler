import type { McpSecretInput, McpServerUpsertRequest } from "./integration-contract.ts";
import {
  MAX_SIMULTANEOUS_WORKERS_LIMIT,
  MAX_WORKER_PROFILES,
  WORKER_PROFILE_BUILTIN_JOBS,
  WORKER_PROFILE_CUSTOM_JOB_TEXT_MAX_LENGTH,
  WORKER_PROFILE_DOMAIN_MAX_LENGTH,
  WORKER_PROFILE_ID_PATTERN,
  WORKER_PROFILE_LABEL_MAX_LENGTH,
  WORKER_PROFILE_MODEL_REF_MAX_LENGTH,
  WORKER_PROFILE_PROMPT_MAX_LENGTH,
  type WorkerProfile,
} from "./settings-contract.ts";
import type {
  ModelFallbackSettingsUpdate,
  UpdateSettingsRequest,
  WebSearchSettingsUpdate,
} from "./settings-contract.ts";

const UPDATE_SETTINGS_KEYS = new Set([
  "server_url",
  "language",
  "timezone",
  "model",
  "reasoning_effort",
  "consolidation_model",
  "consolidation_reasoning_effort",
  "context_window_tokens",
  "worker_profiles",
  "max_simultaneous_workers",
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
  "model_fallback",
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

const WORKER_PROFILE_KEYS = new Set([
  "id",
  "label",
  "enabled",
  "job",
  "domain",
  "model",
  "reasoning_effort",
  "prompt",
]);

const REASONING_EFFORTS = new Set([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
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
    !["none", "low", "medium", "high", "xhigh", "max"].includes(
      String(input.consolidation_reasoning_effort),
    )
  )
    return false;
  if (
    "worker_profiles" in input &&
    !isWorkerProfileList(input.worker_profiles)
  )
    return false;
  if (
    "max_simultaneous_workers" in input &&
    (typeof input.max_simultaneous_workers !== "number" ||
      !Number.isInteger(input.max_simultaneous_workers) ||
      input.max_simultaneous_workers < 1 ||
      input.max_simultaneous_workers > MAX_SIMULTANEOUS_WORKERS_LIMIT)
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
  if (
    "model_fallback" in input &&
    !isModelFallbackSettingsUpdate(input.model_fallback)
  )
    return false;
  return true;
}

function isModelFallbackSettingsUpdate(
  value: unknown,
): value is ModelFallbackSettingsUpdate {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  if (!Object.keys(input).every((key) => ["enabled", "models"].includes(key)))
    return false;
  if ("enabled" in input && typeof input.enabled !== "boolean") return false;
  if (
    "models" in input &&
    (!Array.isArray(input.models) ||
      !input.models.every((model) => typeof model === "string"))
  ) {
    return false;
  }
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

function isWorkerProfileList(value: unknown): value is WorkerProfile[] {
  if (!Array.isArray(value)) return false;
  if (value.length === 0 || value.length > MAX_WORKER_PROFILES) return false;
  const seenIds = new Set<string>();
  return value.every((profile) => {
    if (!profile || typeof profile !== "object" || Array.isArray(profile))
      return false;
    const input = profile as Record<string, unknown>;
    if (!Object.keys(input).every((key) => WORKER_PROFILE_KEYS.has(key)))
      return false;
    if (
      typeof input.id !== "string" ||
      !WORKER_PROFILE_ID_PATTERN.test(input.id)
    ) {
      return false;
    }
    const collisionKey = input.id.toLocaleLowerCase("en-US");
    if (seenIds.has(collisionKey)) return false;
    seenIds.add(collisionKey);
    if (
      typeof input.label !== "string" ||
      !isBoundedText(input.label, WORKER_PROFILE_LABEL_MAX_LENGTH)
    ) {
      return false;
    }
    if (typeof input.enabled !== "boolean") return false;
    if (!isWorkerProfileJob(input.job)) return false;
    if (
      "domain" in input &&
      (typeof input.domain !== "string" ||
        !isBoundedText(input.domain, WORKER_PROFILE_DOMAIN_MAX_LENGTH))
    ) {
      return false;
    }
    if (
      typeof input.model !== "string" ||
      !isBoundedModelRef(input.model)
    ) {
      return false;
    }
    if (
      typeof input.reasoning_effort !== "string" ||
      !REASONING_EFFORTS.has(input.reasoning_effort)
    ) {
      return false;
    }
    if (
      "prompt" in input &&
      (typeof input.prompt !== "string" ||
        input.prompt.length > WORKER_PROFILE_PROMPT_MAX_LENGTH)
    ) {
      return false;
    }
    return true;
  });
}

function isWorkerProfileJob(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const job = value as Record<string, unknown>;
  const keys = Object.keys(job).sort();
  if (job.kind === "builtin") {
    return (
      keys.length === 2 &&
      keys[0] === "job" &&
      keys[1] === "kind" &&
      (WORKER_PROFILE_BUILTIN_JOBS as readonly unknown[]).includes(job.job)
    );
  }
  if (job.kind === "custom") {
    return (
      keys.length === 2 &&
      keys[0] === "kind" &&
      keys[1] === "text" &&
      typeof job.text === "string" &&
      isBoundedText(job.text, WORKER_PROFILE_CUSTOM_JOB_TEXT_MAX_LENGTH)
    );
  }
  return false;
}

function isBoundedModelRef(value: string): boolean {
  const model = value.trim();
  return (
    model.length > 0 &&
    model.length <= WORKER_PROFILE_MODEL_REF_MAX_LENGTH &&
    !/\s/u.test(model)
  );
}

function isBoundedText(value: string, maxLength: number): boolean {
  const text = value.replace(/\s+/gu, " ").trim();
  return text.length > 0 && text.length <= maxLength;
}
