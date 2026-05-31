import { api } from "@/app/api.ts";
import { appCopy } from "@/app/copy.ts";
import { modelDisplayName } from "@/app/utils.ts";
import type {
  AppModelSummary,
  LocalModelDeletionResult,
  LocalModelDiscoveryResult,
  LocalModelDiscoveryRequest,
  LocalModelRegistrationRequest,
  LocalModelRegistrationResult,
} from "@/app/types.ts";

const API_TYPE = "openai_compatible" as const;

export function localModelPayload(
  sourceModel: AppModelSummary | null,
  platform: LocalModelDiscoveryRequest["platform"],
  serverUrl: string,
  manualModelId: string,
  manualDisplayName: string,
  manualContext: string,
  reasoningBudgetRatio?: number,
): LocalModelRegistrationRequest {
  return {
    provider_id: "local",
    api_type: API_TYPE,
    platform,
    server_url: serverUrl || sourceModel?.server_url || "",
    model_id: manualModelId || sourceModel?.model_id || "",
    display_name: manualDisplayName || sourceModel?.display_name,
    context_window_tokens:
      Number(manualContext) || sourceModel?.context_window_tokens || 16_384,
    max_output_tokens: sourceModel?.max_output_tokens,
    reasoning_budget_ratio: reasoningBudgetRatio,
    source: sourceModel ? "discovered" : "manual",
  };
}

export async function discoverLocalModels(
  platform: LocalModelDiscoveryRequest["platform"],
  serverUrl: string,
): Promise<LocalModelDiscoveryResult> {
  const result = await api<LocalModelDiscoveryResult>(
    "/model-catalog/local/discover",
    {
      method: "POST",
      body: JSON.stringify({
        provider_id: "local",
        api_type: API_TYPE,
        platform,
        server_url: serverUrl,
      }),
    },
  );
  return result;
}

export async function registerLocalModel(
  isEditing: boolean,
  editingModelRef: string,
  payload: LocalModelRegistrationRequest,
): Promise<LocalModelRegistrationResult> {
  const result = await api<LocalModelRegistrationResult>(
    isEditing
      ? `/model-catalog/local-models/${encodeURIComponent(editingModelRef)}`
      : "/model-catalog/local-models",
    {
      method: isEditing ? "PATCH" : "POST",
      body: JSON.stringify(payload),
    },
  );
  return result;
}

export async function deleteLocalModel(
  model: AppModelSummary,
): Promise<LocalModelDeletionResult> {
  const copy = appCopy.settings.localModels;
  const confirmed = window.confirm(
    copy.deleteConfirm(modelDisplayName(model)),
  );
  if (!confirmed) throw new Error("Deletion cancelled");

  const result = await api<LocalModelDeletionResult>(
    `/model-catalog/local-models/${encodeURIComponent(model.model_ref)}`,
    { method: "DELETE" },
  );
  return result;
}
