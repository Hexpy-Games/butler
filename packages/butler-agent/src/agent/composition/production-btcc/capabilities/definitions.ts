import type { ProductionCapability } from "./contracts.ts";
import { executeFileCapability } from "./file-capabilities.ts";
import { executeCommandCapability } from "./command-capability.ts";
import { executeWebCapability } from "./web-capabilities.ts";
import { readProjectLedger } from "./project-ledger-capability.ts";
import { updateProjectLedger } from "./project-ledger-mutation-capability.ts";
import { updateOnboardingProfile } from "./onboarding-profile-capability.ts";
import { updateOnboardingProfileToolDefinition } from
  "../../../tools/memory/update_onboarding_profile/definition.ts";

const object = (
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const string = (description?: string) => ({ type: "string", ...(description ? { description } : {}) });
const integer = (minimum?: number, maximum?: number) => ({
  type: "integer",
  ...(minimum === undefined ? {} : { minimum }),
  ...(maximum === undefined ? {} : { maximum }),
});
const strings = (description?: string) => ({
  type: "array",
  items: { type: "string" },
  ...(description ? { description } : {}),
});
const PROJECT_LEDGER_RECORD_KINDS = [
  "initiative", "decision", "risk", "spec", "report", "plan", "handoff",
  "reference", "roadmap", "work", "task", "attempt",
] as const;
const projectLedgerKinds = () => ({
  type: "array",
  items: { type: "string", enum: PROJECT_LEDGER_RECORD_KINDS },
});
const projectLedgerUpdate = () => object({
  id: string("Exact existing Project Ledger record id."),
  kind: { type: "string", enum: PROJECT_LEDGER_RECORD_KINDS },
  title: string(),
  status: string(),
  body: string(),
  spec: string(),
  acceptance: string(),
  validation: string(),
  review: string(),
  report: string(),
  implementation: string(),
  mitigation: string(),
  reason: string(),
  code_commits: string(),
  ledger_commits: string(),
}, ["id"]);

export const PRODUCTION_CAPABILITIES: readonly ProductionCapability[] = [
  {
    capabilityRef: "update_onboarding_profile",
    name: "update_onboarding_profile",
    description: updateOnboardingProfileToolDefinition.description,
    operationKinds: ["turn_local_effect"],
    inputSchema: updateOnboardingProfileToolDefinition.parameters,
    execute: updateOnboardingProfile,
  },
  {
    capabilityRef: "list_files",
    name: "list_files",
    description: "List bounded workspace-relative file paths in deterministic source-first order.",
    operationKinds: ["observe", "workspace_artifact_observation", "review_validation"],
    observationScopeKinds: ["workspace"],
    inputSchema: object({
      include_globs: strings("Optional workspace-relative globs. A basename glob such as *.ts matches at any depth."),
      exclude_globs: strings("Optional workspace-relative globs to exclude."),
      max_files: integer(1, 1_000),
    }, []),
    execute: (args, context) => executeFileCapability("list_files", args, context),
  },
  {
    capabilityRef: "read_file",
    name: "read_file",
    description: "Read bounded UTF-8 text and return its complete-file sha256.",
    operationKinds: ["observe", "workspace_artifact_observation", "review_validation"],
    observationScopeKinds: ["workspace"],
    inputSchema: object({
      path: string("Workspace-relative path."),
      start_line: integer(1),
      limit_lines: integer(1, 10_000),
      max_bytes: integer(1, 1_048_576),
    }, ["path"]),
    execute: (args, context) => executeFileCapability("read_file", args, context),
  },
  {
    capabilityRef: "write_file",
    name: "write_file",
    description: "Atomically create or replace UTF-8 text inside an isolated workspace.",
    operationKinds: ["workspace_artifact_action"],
    inputSchema: object({
      path: string("Workspace-relative path."),
      content: string(),
      overwrite: { type: "boolean" },
      create_parents: { type: "boolean" },
    }, ["path", "content", "overwrite"]),
    execute: (args, context) => executeFileCapability("write_file", args, context),
  },
  {
    capabilityRef: "grep_files",
    name: "grep_files",
    description: "Search bounded workspace text in deterministic source-first order.",
    operationKinds: ["observe", "workspace_artifact_observation", "review_validation"],
    observationScopeKinds: ["workspace"],
    inputSchema: object({
      pattern: string("Literal search text unless regex is true."),
      regex: { type: "boolean" },
      case_sensitive: { type: "boolean" },
      include_globs: strings("Optional workspace-relative globs. A basename glob such as *.ts matches at any depth."),
      exclude_globs: strings("Optional workspace-relative globs to exclude."),
      context: integer(0, 10),
      max_matches: integer(1, 1_000),
    }, ["pattern"]),
    execute: (args, context) => executeFileCapability("grep_files", args, context),
  },
  {
    capabilityRef: "run_command",
    name: "run_command",
    description: "Run one structurally classified non-interactive local command.",
    operationKinds: ["observe", "workspace_artifact_action", "review_validation"],
    observationScopeKinds: ["workspace"],
    inputSchema: object({
      command: string(),
      cwd: string(),
      timeout_ms: integer(1, 600_000),
      state_effect: {
        type: "string",
        enum: ["read_only", "mutation", "validation"],
      },
    }, ["command", "state_effect"]),
    execute: executeCommandCapability,
  },
  {
    capabilityRef: "web_search",
    name: "web_search",
    description: "Search the public web for current or external information.",
    operationKinds: ["observe"],
    observationScopeKinds: ["web"],
    inputSchema: object({
      query: string(),
      allowed_domains: strings(),
      blocked_domains: strings(),
      recency_days: integer(1),
      max_results: integer(1, 10),
    }, ["query"]),
    execute: (args, context) => executeWebCapability("web_search", args, context),
  },
  {
    capabilityRef: "web_read",
    name: "web_read",
    description: "Read a bounded public http(s) page.",
    operationKinds: ["observe"],
    observationScopeKinds: ["web"],
    inputSchema: object({
      url: string(),
      backend: {
        type: "string",
        enum: ["auto", "lightpanda", "lightweight", "jina-hosted", "disabled"],
      },
    }, ["url"]),
    execute: (args, context) => executeWebCapability("web_read", args, context),
  },
  {
    capabilityRef: "project_ledger_read",
    name: "project_ledger_read",
    description: "Discover canonical Project Ledger semantic records by metadata, then read bodies by explicit record_ids. Internal normalized reference records require kinds=[\"reference\"]. include_body=true requires non-empty record_ids. Query terms use case-insensitive any-term matching across record metadata and body but return metadata unless exact IDs are supplied. Observed records are context, not continuation authority.",
    operationKinds: ["observe", "review_validation"],
    observationScopeKinds: ["ledger"],
    inputSchema: object({
      record_ids: strings(),
      kinds: projectLedgerKinds(),
      query: string(),
      include_body: { type: "boolean" },
      max_records: integer(1, 50),
    }, []),
    execute: readProjectLedger,
  },
  {
    capabilityRef: "project_ledger_update",
    name: "project_ledger_update",
    description: "Atomically update a coherent batch of existing records in the exact admitted Project Ledger and return its new canonical head.",
    operationKinds: ["external_effect"],
    inputSchema: object({
      updates: {
        type: "array",
        minItems: 1,
        maxItems: 50,
        items: projectLedgerUpdate(),
      },
    }, ["updates"]),
    execute: updateProjectLedger,
  },
];
