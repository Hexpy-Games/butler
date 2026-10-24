import { api } from "./api.ts";
import type { OpenAIOAuthLoginResult } from "@/components/settings/modelManagementApi";
export type { ChatGptSignInKind as SignInKind } from "./types.ts";
import type { ChatGptSignInKind as SignInKind } from "./types.ts";
export interface ChatGptAccountView {
  status: "signed_out" | "legacy_sign_in_required" | "sign_in_required" | "plan_off" | "signed_in";
  label: string | null;
  plan_notice_pending: boolean;
  legacy_prompt_pending: boolean;
}
export interface SignInSession { backend: "agent"; view: OpenAIOAuthLoginResult }
export async function startSignIn(input: { force?: boolean; kind?: SignInKind } = {}): Promise<SignInSession> {
  return { backend: "agent", view: await api<OpenAIOAuthLoginResult>("/setup/oauth/start", {
    method: "POST", body: JSON.stringify({ kind: "default", ...input }),
  }) };
}
export async function signInStatus(session: SignInSession): Promise<OpenAIOAuthLoginResult> {
  return await api<OpenAIOAuthLoginResult>(`/setup/oauth/${encodeURIComponent(session.view.flow_id!)}`);
}
export async function cancelSignIn(session: SignInSession): Promise<OpenAIOAuthLoginResult | undefined> {
  if (!session.view.flow_id) return undefined;
  return await api<OpenAIOAuthLoginResult>(`/setup/oauth/${encodeURIComponent(session.view.flow_id)}/cancel`, { method: "POST", body: "{}" });
}
export function chatGptAccount(): Promise<ChatGptAccountView> { return api("/setup/chatgpt-account"); }
export function acknowledgeChatGptNotice(kind: "plan" | "legacy"): Promise<ChatGptAccountView> {
  return api("/setup/chatgpt-account/notice", { method: "POST", body: JSON.stringify({ kind }) });
}
