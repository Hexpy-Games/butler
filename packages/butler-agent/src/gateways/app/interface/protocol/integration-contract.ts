import type { WorkerModelRule } from "./settings-contract.ts";

export type McpTransportKind = "stdio" | "http" | "sse";
export type McpSecretSource = "literal" | "env" | "file";

export interface McpSecretInput {
  key: string;
  source: McpSecretSource;
  value: string;
}

export interface McpSecretView {
  key: string;
  source: McpSecretSource;
  value?: string;
  redacted: boolean;
  has_value: boolean;
}

export interface McpServerView {
  id: string;
  display_name: string;
  enabled: boolean;
  transport: McpTransportKind;
  command?: string;
  args: string[];
  cwd?: string;
  url?: string;
  env: McpSecretView[];
  headers: McpSecretView[];
  created_at: string;
  updated_at: string;
}

export interface McpServerListView {
  storage_path: string;
  servers: McpServerView[];
}

export interface McpServerMutationResult {
  server: McpServerView;
}

export interface McpServerDeleteResult {
  id: string;
  removed: boolean;
}

export interface McpServerUpsertRequest {
  id?: string;
  display_name?: string;
  enabled?: boolean;
  transport?: McpTransportKind;
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  env?: McpSecretInput[];
  headers?: McpSecretInput[];
}

export interface McpServerCapabilitiesView {
  id: string;
  display_name: string;
  enabled: boolean;
  transport: McpTransportKind;
  tools: Array<{
    name: string;
    qualified_name: string;
    description?: string;
    input_schema?: Record<string, unknown>;
  }>;
  resources: Array<{
    uri: string;
    name: string;
    description?: string;
    mime_type?: string;
  }>;
  resource_templates: Array<{
    uri_template: string;
    name: string;
    description?: string;
    mime_type?: string;
  }>;
  ok: boolean;
  error: string | null;
}

export interface McpCapabilitiesView {
  servers: McpServerCapabilitiesView[];
}

export interface SkillSummaryView {
  name: string;
  description: string;
  source: "core" | "user" | "project";
  project_id?: string;
  file_path: string;
  user_invocable: boolean;
}

export interface SkillProjectView {
  id: string;
  display_name: string;
  skills: SkillSummaryView[];
}

export interface SkillSettingsView {
  storage_root: string;
  core: SkillSummaryView[];
  user: SkillSummaryView[];
  projects: SkillProjectView[];
}

export interface SkillImportResult {
  imported: SkillSummaryView[];
  skipped: string[];
}

export type ProviderAuthMethod = "api_key" | "codex_oauth";

export interface AppModelSummary {
  provider_id: string;
  provider_label: string;
  provider_family_id?: string;
  model_id: string;
  model_ref: string;
  display_name: string;
  status: "latest" | "recommended" | "available" | "deprecated";
  context_window_tokens?: number;
  max_output_tokens?: number;
  default_reasoning_effort: "none" | "low" | "medium" | "high" | "xhigh" | "max";
  reasoning_efforts: Array<"none" | "low" | "medium" | "high" | "xhigh" | "max">;
  reasoning_budget_tokens?: Partial<
    Record<"none" | "low" | "medium" | "high" | "xhigh" | "max", number>
  >;
  token_estimator: string;
  source_url: string;
  runtime_supported: boolean;
  hosted_api_shape?:
    | "openai_chat_completions"
    | "openai_responses"
    | "anthropic_messages"
    | "gemini_generate_content";
  api_base_url?: string;
  api_type?: "openai_compatible";
  platform?: "llama_cpp" | "ollama" | "lm_studio" | "custom";
  server_url?: string;
  source?: "discovered" | "manual";
  local_reasoning_budget_ratio?: number;
  registered?: boolean;
  auth_type?: ProviderAuthMethod;
  credential_id?: string;
  credential_label?: string;
  credential_masked_value?: string;
}

export interface ProviderCredentialView {
  id: string;
  provider_id: string;
  auth_type: ProviderAuthMethod;
  label: string;
  masked_value: string;
  created_at: string;
  updated_at: string;
}

export interface ModelCatalogView {
  generation: string;
  generated_at: string;
  default_model_ref: string;
  default_reasoning_effort: "none" | "low" | "medium" | "high" | "xhigh" | "max";
  providers: Array<{
    provider_id: string;
    provider_label: string;
    latest_model_ref: string;
    auth_methods: ProviderAuthMethod[];
    default_api_base_url?: string;
    models: AppModelSummary[];
  }>;
  models: AppModelSummary[];
  registered_models: AppModelSummary[];
  provider_credentials: ProviderCredentialView[];
  worker_model_presets: Array<{
    provider_id: string;
    provider_label: string;
    runtime_supported: boolean;
    source_url: string;
    deep_work: WorkerModelRule;
    routine_work: WorkerModelRule;
  }>;
}

export interface LocalModelDiscoveryRequest {
  provider_id: "local";
  api_type: "openai_compatible";
  platform: "llama_cpp" | "ollama" | "lm_studio" | "custom";
  server_url: string;
}

export interface LocalModelDiscoveryResult {
  server_url: string;
  api_base_url: string;
  api_type: "openai_compatible";
  platform: "llama_cpp" | "ollama" | "lm_studio" | "custom";
  models: AppModelSummary[];
}

export interface LocalModelRegistrationRequest {
  provider_id: "local";
  api_type: "openai_compatible";
  platform: "llama_cpp" | "ollama" | "lm_studio" | "custom";
  server_url: string;
  model_id: string;
  display_name?: string;
  context_window_tokens: number;
  max_output_tokens?: number;
  reasoning_budget_ratio?: number;
  source?: "discovered" | "manual";
}

export interface LocalModelRegistrationResult {
  model: AppModelSummary;
  catalog: ModelCatalogView;
}

export interface ProviderCredentialUpsertRequest {
  provider_id: string;
  auth_type: "api_key";
  label?: string;
  api_key: string;
  credential_id?: string;
}

export interface ProviderCredentialMutationResult {
  credential: ProviderCredentialView;
  catalog: ModelCatalogView;
}

export interface HostedModelRegistrationRequest {
  provider_id: string;
  model_id: string;
  display_name?: string;
  auth_type: ProviderAuthMethod;
  credential_id?: string;
  api_key?: string;
  credential_label?: string;
  api_base_url?: string;
}

export interface HostedModelRegistrationResult {
  model: AppModelSummary;
  catalog: ModelCatalogView;
}

export interface HostedModelDeletionResult {
  removed_model_ref: string;
  catalog: ModelCatalogView;
}

export interface LocalModelUpdateRequest extends LocalModelRegistrationRequest {}

export interface LocalModelDeletionResult {
  removed_model_ref: string;
  catalog: ModelCatalogView;
}
