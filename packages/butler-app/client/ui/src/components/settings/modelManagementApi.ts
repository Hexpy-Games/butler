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

export async function startOpenAIOAuthLogin(): Promise<OpenAIOAuthLoginResult> {
  return await callOpenAIOAuthBridge("startOpenAIOAuthLogin");
}

export async function restartOpenAIOAuthLogin(): Promise<OpenAIOAuthLoginResult> {
  return await callOpenAIOAuthBridge("restartOpenAIOAuthLogin");
}

export async function getOpenAIOAuthLoginStatus(): Promise<OpenAIOAuthLoginResult> {
  return await callOpenAIOAuthBridge("getOpenAIOAuthLoginStatus");
}

export async function submitOpenAIOAuthCallback(
  callbackUrl: string,
): Promise<OpenAIOAuthLoginResult> {
  return await callOpenAIOAuthBridge("submitOpenAIOAuthCallback", {
    callbackUrl,
  });
}

async function callOpenAIOAuthBridge(
  method:
    | "getOpenAIOAuthLoginStatus"
    | "restartOpenAIOAuthLogin"
    | "startOpenAIOAuthLogin"
    | "submitOpenAIOAuthCallback",
  input?: unknown,
): Promise<OpenAIOAuthLoginResult> {
  const bridge = typeof window !== "undefined"
    ? (window.butlerApp as Record<string, unknown> | undefined)
    : undefined;
  if (!bridge) return { status: "profile_exists" };
  const call = bridge[method];
  if (typeof call !== "function") {
    throw new Error(appCopy.settings.modelManagement.errors.oauthLogin);
  }
  return await call(input) as OpenAIOAuthLoginResult;
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
