import { AuthorityRequestError } from "../../../../../agent/btcc/authority/index.ts";
import { apiEnvelope } from "../../protocol/app-protocol.ts";
import {
  AuthorityHandoffError,
  decideAndAdmitAuthority,
} from "../../../application/authority-handoff.ts";
import { sessionHintForRow } from "../../../domain/sessions/session-read-model.ts";
import { RequestError, json } from "../responses.ts";
import type { AppRouteContext } from "../server-types.ts";

export async function handleAuthorityRoutes(
  input: AppRouteContext,
): Promise<Response | null> {
  if (!input.url.pathname.startsWith("/authority-requests") && !input.url.pathname.startsWith("/authority-permissions")) return null;
  const sessionId = input.url.searchParams.get("session_id")?.trim() || "general";
  const ownerSessionId = sessionHintForRow(sessionId);

  const revoke = input.request.method === "DELETE" && input.url.pathname.match(/^\/authority-permissions\/([^/]+)$/u);
  if (revoke) {
    input.authority.revokePermission(ownerSessionId, decodeURIComponent(revoke[1]!));
    return json(apiEnvelope({ revoked: true }));
  }

  if (input.request.method === "GET" && input.url.pathname === "/authority-requests") {
    return json(apiEnvelope({
      session_id: sessionId,
      requests: input.authority.list({ ownerSessionId }),
      permissions: input.authority.listPermissions(ownerSessionId).map((permission) => ({
        grant_ref: permission.grantRef, title: permission.title, description: permission.description,
      })),
    }));
  }

  const match = input.request.method === "POST"
    ? input.url.pathname.match(/^\/authority-requests\/([^/]+)\/(allow|deny|modify)$/u)
    : null;
  if (!match) return null;
  const requestRef = decodeURIComponent(match[1]!);
  const decisionAction = match[2] as "allow" | "deny" | "modify";
  let handoff;
  try {
    handoff = await decideAndAdmitAuthority({
      authority: input.authority,
      store: input.store,
      butlerData: input.butlerData,
      stewardObserver: input.stewardObserver,
      ownerSessionId,
      requestRef,
      action: decisionAction,
      ...(decisionAction === "allow" ? { allowScope: await allowScope(input.request) } : {}),
      ...(decisionAction === "modify"
        ? { alternativeInput: await modifyInput(input.request) }
        : {}),
    });
  } catch (error) {
    if (error instanceof AuthorityRequestError) {
      if (error.code === "authority_modify_input_missing" ||
          error.code === "authority_modify_input_too_large") {
        throw new RequestError(400, error.code, "Modify instruction is invalid.");
      }
      if (error.code === "authority_modify_identity_mismatch") {
        throw new RequestError(409, error.code, "Modify instruction conflicts with the stored decision.");
      }
      if (error.code === "authority_decision_conflict") {
        throw new RequestError(409, error.code, "The authority request already has a different decision.");
      }
      throw new RequestError(404, "authority_request_not_found", "Authority request not found.");
    }
    if (error instanceof AuthorityHandoffError) {
      throw new RequestError(409, error.code, "Authority queue admission could not be verified.");
    }
    throw error;
  }
  return json(apiEnvelope({
    request_ref: handoff.decision.requestRef,
    decision: handoff.decision.decision,
    scheduled: handoff.admitted,
  }), 202);
}

async function allowScope(request: Request): Promise<"once" | "conversation"> {
  const text = await request.text();
  if (!text.trim()) return "once";
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new RequestError(400, "authority_scope_invalid", "Invalid permission scope."); }
  if (value && typeof value === "object" && "scope" in value && (value.scope === "once" || value.scope === "conversation")) return value.scope;
  throw new RequestError(400, "authority_scope_invalid", "Invalid permission scope.");
}

async function modifyInput(request: Request): Promise<string> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new RequestError(400, "authority_modify_input_missing", "Modify instruction is invalid.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new RequestError(400, "authority_modify_input_missing", "Modify instruction is invalid.");
  }
  const record = body as Record<string, unknown>;
  const alternative = record.alternative ?? record.instruction;
  if (typeof alternative !== "string" || !alternative.trim()) {
    throw new RequestError(400, "authority_modify_input_missing", "Modify instruction is invalid.");
  }
  return alternative;
}
