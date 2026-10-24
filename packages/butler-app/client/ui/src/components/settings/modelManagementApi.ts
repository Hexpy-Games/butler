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

export interface OpenAIOAuthLoginResult {
  auth_url?: string;
  error?: string;
  plan_enabled?: boolean;
  /** Id of the agent sign-in flow. */
  flow_id?: string;
  label?: string;
  redirect_uri?: string;
  status:
    | "cancelled"
    | "completed"
    | "failed"
    | "idle"
    | "pending"
    | "profile_exists"
    | "starting";
}

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
  const confirmed = await confirmAction(copy.deleteConfirm(modelDisplayName(model)), {
    title: appCopy.common.delete, confirmLabel: appCopy.common.delete, destructive: true,
  });
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
import { confirmAction } from "@/app/confirmation.ts";
