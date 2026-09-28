import { api } from "./api.ts";
import { isMissingRoute } from "./setupConnection.ts";
import {
  cancelOpenAIOAuthLogin,
  getOpenAIOAuthLoginStatus,
  startOpenAIOAuthLogin,
  type OpenAIOAuthLoginResult,
} from "@/components/settings/modelManagementApi";

/**
 * ChatGPT sign-in during first run. The agent runs the flow (#279):
 * `POST /setup/oauth/start`, `GET /setup/oauth/{flow_id}`,
 * `POST /setup/oauth/{flow_id}/cancel`; the app opens the browser at
 * `auth_url`. An agent without those routes falls back to the desktop app's
 * sign-in helper, which opens the browser itself.
 */
export type SignInBackend = "agent" | "desktop";

export interface SignInSession {
  backend: SignInBackend;
  view: OpenAIOAuthLoginResult;
}

export async function startSignIn(): Promise<SignInSession> {
  try {
    const view = await api<OpenAIOAuthLoginResult>("/setup/oauth/start", { method: "POST", body: JSON.stringify({}) });
    return { backend: "agent", view };
  } catch (error) {
    if (!isMissingRoute(error)) throw error;
    return { backend: "desktop", view: await startOpenAIOAuthLogin() };
  }
}

export async function signInStatus(session: SignInSession): Promise<OpenAIOAuthLoginResult> {
  if (session.backend === "desktop" || !session.view.flow_id) return await getOpenAIOAuthLoginStatus();
  return await api<OpenAIOAuthLoginResult>(`/setup/oauth/${encodeURIComponent(session.view.flow_id)}`);
}

/** Closes the flow's callback listener and drops its state. */
export async function cancelSignIn(session: SignInSession): Promise<void> {
  const flowId = session.view.flow_id;
  if (session.backend === "desktop") {
    await cancelOpenAIOAuthLogin(flowId);
    return;
  }
  if (flowId) await api(`/setup/oauth/${encodeURIComponent(flowId)}/cancel`, { method: "POST", body: JSON.stringify({}) });
}

/** Opens the sign-in page in the system browser (Electron routes window.open there). */
export function openSignInPage(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}
