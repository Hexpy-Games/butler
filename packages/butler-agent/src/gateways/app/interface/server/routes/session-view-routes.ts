import {
  apiEnvelope,
  type ContextDetailsView,
  type SessionSummaryView,
  type SessionView,
  type TranscriptExportView,
} from "../../protocol/app-protocol.ts";
import { json, RequestError } from "../responses.ts";
import type { AppRouteContext } from "../server-types.ts";

export function handleSessionViewRoutes(
  input: AppRouteContext,
): Response | null {
  if (input.request.method !== "GET") return null;

  if (input.url.pathname === "/session-summary") {
    const sessionId = requiredSessionId(input);
    input.store.refreshSessionProjection(sessionId);
    return json(
      apiEnvelope<SessionSummaryView>(input.store.getSessionSummary(sessionId)),
    );
  }

  if (input.url.pathname === "/session-view") {
    const sessionId = requiredSessionId(input);
    input.store.refreshSessionProjection(sessionId);
    return json(apiEnvelope<SessionView>(input.store.getSessionView(sessionId)));
  }

  if (input.url.pathname === "/context-details") {
    const sessionId = requiredSessionId(input);
    input.store.refreshSessionProjection(sessionId);
    return json(
      apiEnvelope<ContextDetailsView>(input.store.getContextDetails(sessionId)),
    );
  }

  if (input.url.pathname === "/artifacts") {
    const sessionId = requiredSessionId(input);
    input.store.refreshSessionProjection(sessionId);
    return json(
      apiEnvelope({ artifacts: input.store.listArtifacts(sessionId) }),
    );
  }

  if (input.url.pathname === "/transcript-export") {
    return json(
      apiEnvelope<TranscriptExportView>(
        input.store.exportTranscript(requiredSessionId(input)),
      ),
    );
  }
  return null;
}

function requiredSessionId(input: AppRouteContext): string {
  const sessionId =
    input.url.searchParams.get("session_id") ??
    input.url.searchParams.get("sessionId");
  if (sessionId) return sessionId;
  throw new RequestError(400, "session_required", "Session id is required.");
}
