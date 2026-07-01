import { APP_PROTOCOL_VERSION } from "./base-contract.ts";
import type { PaginationView } from "./navigation-contract.ts";

export interface AppInfoView {
  name: string;
  version: string;
  repository_url: string;
  protocol_version: typeof APP_PROTOCOL_VERSION;
  developer_mode_available: boolean;
  developer_mode_enabled: boolean;
}

export interface SystemEventMetric {
  label: string;
  value: string | number | boolean;
}

export interface SystemEventSummary {
  id: string;
  kind: "scheduler_job" | "consolidation_run" | "profile_consolidation";
  title: string;
  status: string;
  occurred_at?: string;
  started_at?: string;
  completed_at?: string;
  duration_ms?: number;
  model_ref?: string;
  uses_butler_model?: boolean;
  metrics: SystemEventMetric[];
  raw_text_included: false;
}

export interface SystemEventListView {
  events: SystemEventSummary[];
  pagination: PaginationView;
  generated_at: string;
  raw_text_included: false;
}

export interface UsageTokenBucketView {
  requestCount: number;
  promptTokens: number;
  cachedTokens: number;
  uncachedTokens: number;
  outputTokens: number;
  totalTokens: number;
  missingTotalTokenCount: number;
}

export interface UsageMonitorView {
  filters: {
    sessionId: string | null;
    sinceTs: number | null;
  };
  model: UsageTokenBucketView & {
    cacheHitRatio: number;
    byScope: Record<string, number>;
    byScopeUsage: Record<string, UsageTokenBucketView>;
    byModel: Record<string, UsageTokenBucketView>;
  };
  webSearch: {
    requestCount: number;
    lastProvider: string | null;
    lastError: string | null;
  };
  tools: {
    calls: number;
    results: number;
    successes: number;
    failures: number;
    byTool: Record<string, {
      calls: number;
      results: number;
      successes: number;
      failures: number;
    }>;
  };
  providerUsage: {
    activeProviderId: string | null;
    providers: Array<UsageTokenBucketView & {
      providerId: string;
      source: "local_telemetry" | "provider_adapter";
      remaining: {
        available: boolean;
        reason: string;
      };
      billing: {
        available: boolean;
        reason: string;
      };
    }>;
  };
  cost: {
    available: false;
    estimatedUsd: null;
    reason: string;
  };
  privacy: {
    rawTextStored: false;
    rawToolArgumentsIncluded: false;
    rawToolResultsIncluded: false;
  };
  generated_at: string;
  raw_text_included: false;
}

export type UpdateComponentId = "service" | "app";
export type UpdateRestartPolicy = "restart-service" | "restart-app";
export type UpdatePolicy = "explicit" | "app-user-action";
export type UpdateProduct = "butler-agent" | "butler-app";
export type UpdateCanonicalComponent = "agent" | "app";
export type UpdateProfile = "agent-standalone" | "electron";
export type UpdateUpdaterOwner = "butler-agent" | "butler-app";
export type UpdatePayloadFormat = "agent-archive" | "platform-app-package";
export type UpdateStagingPolicy = "butler-data-updates" | "platform-updater-cache";
export type UpdateActivationPolicy = "versioned-standalone-runtime" | "platform-app-update-then-versioned-app-runtime";
export type UpdateRollbackPolicy = "preserve-previous-standalone-runtime" | "preserve-previous-app-managed-runtime";

export interface UpdateIntegrityMetadata {
  digestAlgorithm: "sha256";
  digest: string | null;
  signature: string | null;
}

export interface ComponentUpdateStatus {
  component: UpdateComponentId;
  current_version: string;
  available_version: string;
  update_available: boolean;
  channel: string;
  artifact_url: string | null;
  sha256: string | null;
  signature: string | null;
  bundled_components: UpdateComponentId[];
  product: UpdateProduct;
  canonical_component: UpdateCanonicalComponent;
  profile: UpdateProfile;
  protocol_compatibility: Record<string, string>;
  integrity: UpdateIntegrityMetadata;
  update_policy: UpdatePolicy;
  restart_policy: UpdateRestartPolicy;
  updater_owner: UpdateUpdaterOwner;
  payload_format: UpdatePayloadFormat;
  staging_policy: UpdateStagingPolicy;
  activation_policy: UpdateActivationPolicy;
  rollback_policy: UpdateRollbackPolicy;
  checked_at: string;
  staged: boolean;
  stage_path: string;
  stage_status: "up_to_date" | "staged" | "activated" | "rolled_back" | "dry_run";
  activation_status: "not_required" | "activated" | "rolled_back";
  active_runtime_path: string | null;
  attempted_runtime_path: string | null;
  previous_runtime_path: string | null;
  rollback_reason: string | null;
  manifest_source: string;
}

export interface UpdateStatusView {
  generated_at: string;
  components: ComponentUpdateStatus[];
  storage_label: "updates";
  manifest_source: string;
  raw_text_included: false;
}

export interface UpdateCheckRequest {
  component?: UpdateComponentId;
  components?: UpdateComponentId[];
  channel?: string;
}

export interface UpdateApplyRequest {
  component: UpdateComponentId;
  channel?: string;
  dry_run?: boolean;
}

export interface UpdateApplyResult extends ComponentUpdateStatus {
  dry_run: boolean;
  dryRun: boolean;
  artifact_path: string | null;
  planned_actions: string[];
  stage_status: "up_to_date" | "staged" | "activated" | "rolled_back" | "dry_run";
  activation_status: "not_required" | "activated" | "rolled_back";
  active_runtime_path: string | null;
  attempted_runtime_path: string | null;
  previous_runtime_path: string | null;
  rollback_reason: string | null;
  raw_text_included: false;
}
