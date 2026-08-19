import type { SettingsView } from "./settings-contract.ts";
import { createHash } from "node:crypto";

/** Internal, typed ingress used by the BTCC Steward result outbox. */
export interface SubsessionResultIngressRequest {
  relation_id: string;
  result_id: string;
  parent_chat_id: string;
  parent_session_id: string;
  parent_turn_id: string;
  message_id: string;
  text: string;
  model_ref: string;
  reasoning_effort: SettingsView["reasoning_effort"];
  access_mode: SettingsView["access_mode"];
  timestamp: string;
}

export interface SubsessionResultIngressResponse {
  accepted: boolean;
  client_message_id: string;
  queued_message_id?: string;
  turn_id?: string;
}

export function subsessionResultClientMessageId(
  relationId: string,
  resultId: string,
): string {
  const digest = createHash("sha256")
    .update(`butler.app.subsession-result.v1\0${relationId}\0${resultId}`)
    .digest("hex");
  return `client-${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}
