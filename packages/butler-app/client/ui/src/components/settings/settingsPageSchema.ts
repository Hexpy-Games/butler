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
  general: [
    { id: "language-region", kind: "form", fields: ["language", "timezone"] },
    { id: "conversation-input", kind: "form", fields: ["follow-up-behavior", "multiline-send"] },
    { id: "notifications", kind: "form", fields: ["desktop-notifications", "notify-assistant-messages", "notify-task-completions"] },
    { id: "notification-permission", kind: "status", fields: ["notification-permission"] },
    { id: "app-behavior", kind: "form", fields: ["desktop-tray", "rerun-setup"] },
    { id: "search-provider", kind: "form", fields: ["search-provider", "search-api-key"] },
    { id: "search-behavior", kind: "form", fields: ["search-reader", "search-planning", "search-depth"] },
  ],
  appearance: [
    { id: "theme", kind: "form", fields: ["theme", "translucent-sidebar"] },
    { id: "sidebar", kind: "form", fields: ["smart-groups"] },
    { id: "home-screen", kind: "form", fields: ["main-screen-wallpaper", "main-screen-motion", "main-screen-battery"] },
  ],
  personalization: [
    { id: "profile", kind: "form", fields: ["butler-nickname", "principal-name", "preferred-address"] },
    { id: "response-style", kind: "form", fields: ["response-language", "persona-preset", "persona", "eol"] },
    { id: "learning", kind: "form", fields: ["profiling-mode", "profiling-model", "profiling-reasoning"] },
    { id: "import", kind: "form", fields: ["profile-migration", "profile-migration-prompt", "profile-migration-dump"] },
  ],
  // Memory cleanup and worker profiles show when the Advanced disclosure is open.
  models: [
    { id: "butler-model", kind: "form", fields: ["primary-model", "reasoning", "context-limit", "local-reasoning-budget"] },
    { id: "backup-models", kind: "form", fields: ["backup-models-summary", "backup-models-enabled", "backup-models"] },
    { id: "permissions", kind: "form", fields: ["access-mode", "plan-mode-default"] },
    { id: "advanced-models", kind: "form", fields: [] },
    { id: "memory-cleanup", kind: "form", fields: ["consolidation-model", "consolidation-reasoning"], optional: true },
    { id: "worker-profiles", kind: "list", fields: WORKER_PROFILE_FIELDS, optional: true },
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
    { id: "usage-providers", kind: "list", fields: [] },
    { id: "usage-scope-tokens", kind: "list", fields: [] },
    { id: "usage-model-tokens", kind: "list", fields: [] },
    { id: "usage-prompt-sections", kind: "list", fields: [] },
    { id: "usage-tools", kind: "list", fields: [] },
  ],
  logs: [{ id: "developer-logs", kind: "list", fields: [] }],
  privacy: [{ id: "diagnostics", kind: "form", fields: ["diagnostics"] }],
  system: [{ id: "system-events", kind: "list", fields: [] }],
  archives: [{ id: "archives", kind: "list", fields: [] }],
  about: [
    { id: "app-info", kind: "info", fields: ["app-name", "app-version", "app-repository", "app-protocol"] },
    { id: "developer", kind: "form", fields: ["developer-mode"] },
  ],
};
