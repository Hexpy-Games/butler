import type { SettingsSectionKind } from "@/butler-ds";
import type { SettingsSectionId } from "@/app/types.ts";

/** One section of a settings page: its id, kind and the setting ids it holds. */
export interface SettingsSectionSchema {
  id: string;
  kind: SettingsSectionKind;
  fields: readonly string[];
  /** Renders only in some states (an open form). */
  optional?: boolean;
}

const WORKER_PROFILE_FIELDS = [
  "worker-name", "worker-enabled", "worker-job", "worker-custom-job",
  "worker-domain", "worker-prompt", "worker-model", "worker-reasoning",
] as const;

/**
 * Declarative settings structure: page -> sections -> field ids. Every page
 * renders exactly these sections in this order (optional ones may be absent)
 * and every setting renders inside the one section that declares it.
 */
export const settingsPageSchema: Record<SettingsSectionId, readonly SettingsSectionSchema[]> = {
  memory: [
    { id: "instructions", kind: "form", fields: [] },
    { id: "noticed-patterns", kind: "form", fields: ["proactive-level", "quiet-hours"] },
    { id: "chat-memory", kind: "form", fields: ["recall-mode", "recall-judge-model", "free-space", "reset-chat-memory"] },
    { id: "memory-cleanup", kind: "form", fields: ["consolidation-time", "consolidation-run", "consolidation-model", "consolidation-reasoning"] },
    { id: "memory-model", kind: "form", fields: ["memory-model"] },
    { id: "profile-memory", kind: "form", fields: ["reset-profile"] },
    { id: "project-memory", kind: "form", fields: ["memory-project", "reset-project-memory"] },
  ],
  general: [
    { id: "language-region", kind: "form", fields: ["language", "timezone"] },
    { id: "conversation-input", kind: "form", fields: ["follow-up-behavior", "multiline-send", "plan-mode-default"] },
    { id: "sidebar", kind: "form", fields: ["smart-groups"] },
    { id: "default-permission", kind: "form", fields: ["access-mode", "schedule-access-mode", "command-sandbox"] },
    { id: "notifications", kind: "form", fields: ["desktop-notifications", "notify-assistant-messages", "notify-task-completions"] },
    { id: "notification-permission", kind: "status", fields: ["notification-permission"] },
    { id: "app-behavior", kind: "form", fields: ["desktop-tray", "rerun-setup"] },
    { id: "search-provider", kind: "form", fields: ["search-provider", "search-api-key"] },
    { id: "search-behavior", kind: "form", fields: ["search-reader", "search-planning", "search-depth"] },
    { id: "full-reset", kind: "form", fields: ["full-reset"] },
  ],
  appearance: [
    { id: "theme", kind: "form", fields: ["theme", "text-size", "translucent-sidebar"] },
    { id: "home-screen", kind: "form", fields: ["main-screen-wallpaper", "main-screen-motion", "main-screen-battery"] },
    { id: "conversation", kind: "form", fields: ["show-thinking", "conversation-background"] },
    { id: "message-box", kind: "form", fields: ["collapse-message-box", "composer-decoration", "composer-character"] },
    { id: "accessibility", kind: "form", fields: ["reduce-motion"] },
  ],
  personalization: [
    { id: "profile", kind: "form", fields: ["butler-nickname", "principal-name", "preferred-address"] },
    { id: "response-style", kind: "form", fields: ["response-language", "persona-preset", "persona", "eol"] },
    { id: "learning", kind: "form", fields: ["profiling-mode", "profiling-model", "profiling-reasoning", "memory-link"] },
    { id: "agent-import", kind: "list", fields: ["profile-migration", "profile-migration-prompt", "profile-migration-dump"] },
  ],
  // Worker profiles show when the Advanced disclosure is open.
  models: [
    { id: "butler-model", kind: "form", fields: ["primary-model", "reasoning", "context-limit", "local-reasoning-budget"] },
    { id: "backup-models", kind: "form", fields: ["backup-models-summary", "backup-models-enabled", "backup-models"] },
    { id: "image-models", kind: "form", fields: ["image-model", "image-credential", "image-quality", "image-key-save", "hosted-credential-select", "hosted-credential-label", "hosted-api-key"] },
    { id: "advanced-models", kind: "form", fields: [] },
    { id: "worker-profiles", kind: "list", fields: WORKER_PROFILE_FIELDS, optional: true },
  ],
  hooks: [
    { id: "hooks", kind: "list", fields: [] },
    { id: "hook-form", kind: "form", fields: [], optional: true },
    { id: "hook-runs", kind: "list", fields: [] },
  ],
  mcp: [
    { id: "mcp-servers", kind: "list", fields: [] },
    { id: "mcp-server-form", kind: "form", fields: [], optional: true },
  ],
  skills: [{ id: "skills", kind: "list", fields: [] }],
  server: [
    { id: "connection", kind: "form", fields: ["server-url"] },
    { id: "projects", kind: "form", fields: ["default-project-folder"] },
  ],
  updates: [{ id: "updates", kind: "list", fields: [] }],
  usage: [
    { id: "usage-overview", kind: "status", fields: [] },
    { id: "usage-history", kind: "status", fields: [] },
    { id: "usage-providers", kind: "status", fields: [] },
    { id: "usage-scope-tokens", kind: "list", fields: [] },
    { id: "usage-model-tokens", kind: "list", fields: [] },
    { id: "usage-prompt-sections", kind: "list", fields: [] },
    { id: "usage-tools", kind: "list", fields: [] },
  ],
  logs: [
    { id: "logs-level", kind: "form", fields: ["log-level"] },
    { id: "logs-viewer", kind: "list", fields: [] },
    { id: "logs-storage", kind: "status", fields: ["logs-export", "logs-clear"] },
    { id: "developer-context-estimates", kind: "list", fields: [] },
  ],
  browser: [
    { id: "browsing-agent", kind: "form", fields: ["browsing-agent"] },
    { id: "browser-history", kind: "form", fields: ["browser-history"] },
    { id: "browser-site-data", kind: "form", fields: ["browser-site-data"] },
    { id: "sign-ins", kind: "list", fields: [] },
    { id: "payment-methods", kind: "list", fields: [] },
    { id: "profiles", kind: "list", fields: [] },
    { id: "purchase-sites", kind: "form", fields: [] },
    { id: "browser-import", kind: "form", fields: ["browser-import-data"] },
  ],
  // Remote-only controls hide when refused. Authority and keys stay visible.
  security: [
    { id: "remote-access", kind: "form", fields: ["remote-access-enabled", "lan-urls"] },
    { id: "device-pairing", kind: "form", fields: ["pairing-code"], optional: true },
    { id: "paired-devices", kind: "list", fields: [], optional: true },
    { id: "grants", kind: "list", fields: [] },
    { id: "saved-keys", kind: "list", fields: [] },
    { id: "connected-accounts", kind: "list", fields: [], optional: true },
    { id: "security-advanced", kind: "form", fields: ["allowed-hosts"], optional: true },
  ],
  system: [{ id: "system-events", kind: "list", fields: [] }],
  archives: [{ id: "archives", kind: "list", fields: [] }],
  about: [
    { id: "app-info", kind: "info", fields: ["app-name", "app-version", "app-repository", "app-protocol"] },
    { id: "diagnostics", kind: "form", fields: ["diagnostics-export"] },
    { id: "developer", kind: "form", fields: ["developer-mode"] },
  ],
};
