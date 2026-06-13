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
  label?: string;
  status: "completed" | "profile_exists";
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

export async function startOpenAIOAuthLogin(): Promise<OpenAIOAuthLoginResult> {
  const bridge = typeof window !== "undefined"
    ? (window.butlerApp as { startOpenAIOAuthLogin?: () => Promise<OpenAIOAuthLoginResult> } | undefined)
    : undefined;
  if (!bridge) return { status: "profile_exists" };
  if (typeof bridge?.startOpenAIOAuthLogin !== "function") {
    throw new Error(appCopy.settings.modelManagement.errors.oauthLogin);
  }
  return await bridge.startOpenAIOAuthLogin();
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
