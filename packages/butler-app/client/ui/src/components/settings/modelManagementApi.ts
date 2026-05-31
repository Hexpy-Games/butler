import { api } from "@/app/api.ts";
import { appCopy } from "@/app/copy.ts";
import { modelDisplayName } from "@/app/utils.ts";
import type {
  AppModelSummary,
  HostedModelDeletionResult,
  HostedModelRegistrationRequest,
  HostedModelRegistrationResult,
  LocalModelDeletionResult,
} from "@/app/types.ts";

export async function registerHostedModel(
  request: HostedModelRegistrationRequest,
): Promise<HostedModelRegistrationResult> {
  return await api<HostedModelRegistrationResult>(
    "/model-catalog/registered-models",
    {
      method: "POST",
      body: JSON.stringify(request),
    },
  );
}

export async function deleteRegisteredModel(
  model: AppModelSummary,
): Promise<HostedModelDeletionResult | LocalModelDeletionResult> {
  const copy = appCopy.settings.modelManagement;
  const confirmed = window.confirm(copy.deleteConfirm(modelDisplayName(model)));
  if (!confirmed) throw new Error("Deletion cancelled");
  if (model.provider_id === "local") {
    return await api<LocalModelDeletionResult>(
      `/model-catalog/local-models/${encodeURIComponent(model.model_ref)}`,
      { method: "DELETE" },
    );
  }
  return await api<HostedModelDeletionResult>(
    `/model-catalog/registered-models/${encodeURIComponent(model.model_ref)}`,
    { method: "DELETE" },
  );
}
