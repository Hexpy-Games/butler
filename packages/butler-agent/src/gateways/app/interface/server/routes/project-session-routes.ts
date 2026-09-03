import {
  apiEnvelope,
  isCreateProjectRequest,
  isCreateSessionRequest,
  isSessionControlUpdateRequest,
  isUpdateSessionRequest,
  type ArchiveListView,
  type CreateProjectResult,
  type CreateSessionResult,
  type NavigationView,
  type NewChatBriefingView,
  type ProjectActionResult,
  type ProjectDashboardView,
  type ProjectListView,
  type ProjectSessionListView,
  type SessionActionResult,
  type SessionControlsView,
  type SessionListView,
  type WorkStatusItemView,
  type WorkStatusView,
} from "../../protocol/app-protocol.ts";
import type { AppServerStore } from "../../../application/store/app-server-store.ts";
import { paginationFromSearchParams } from "../route-params.ts";
import { json, parseJson, RequestError } from "../responses.ts";
import { conversationSessionIdForDurableSession } from
  "../../../../../agent/conversation/index.ts";
import { sanitizePublicText } from "../../../../../agent/events/public-text.ts";
import {
  projectLifecycleActionWithAuthorityClose,
  sessionLifecycleStopWithAuthorityClose,
} from "../../../application/session-authority-operational-close.ts";

import type { AppRouteContext } from "../server-types.ts";

export async function handleProjectSessionRoutes(
  input: AppRouteContext,
): Promise<Response | null> {
  const { url } = input;
  if (input.request.method === "GET" && url.pathname === "/chats") {
    return json(apiEnvelope(input.store.listChats()));
  }
  if (input.request.method === "GET" && url.pathname === "/navigation") {
    return json(apiEnvelope<NavigationView>(input.store.listNavigation()));
  }
  if (input.request.method === "GET" && url.pathname === "/work-status") {
    return json(apiEnvelope<WorkStatusView>(
      enrichWorkStatusFromConversation(
        input.store,
        input.stewardObserver.workStatus(),
      ),
    ));
  }
  if (input.request.method === "GET" && url.pathname === "/new-chat-briefing") {
    return json(
      apiEnvelope<NewChatBriefingView>(
        input.store.getNewChatBriefing({
          date: url.searchParams.get("date"),
          projectId: url.searchParams.get("project_id"),
        }),
      ),
    );
  }
  if (input.request.method === "GET" && url.pathname === "/archives") {
    return json(
      apiEnvelope<ArchiveListView>(
        input.store.listArchives(paginationFromSearchParams(url.searchParams)),
      ),
    );
  }
  if (input.request.method === "GET" && url.pathname === "/projects") {
    return json(
      apiEnvelope<ProjectListView>(
        input.store.listProjects({
          includeSessions: url.searchParams.get("include_sessions") === "true",
        }),
      ),
    );
  }
  if (input.request.method === "POST" && url.pathname === "/projects") {
    const body = await parseJson(input.request);
    if (!isCreateProjectRequest(body)) {
      throw new RequestError(
        400,
        "invalid_request",
        "Project source is required.",
      );
    }
    return json(
      apiEnvelope<CreateProjectResult>(input.store.createProject(body)),
      201,
    );
  }
  const projectDashboardMatch =
    input.request.method === "GET"
      ? url.pathname.match(/^\/projects\/([^/]+)\/dashboard$/u)
      : null;
  if (projectDashboardMatch) {
    return json(
      apiEnvelope<ProjectDashboardView>(
        input.store.getProjectDashboard(
          decodeURIComponent(projectDashboardMatch[1]!),
        ),
      ),
    );
  }
  const projectMatch = url.pathname.match(/^\/projects\/([^/]+)$/u);
  if (input.request.method === "PATCH" && projectMatch) {
    const body = await parseJson(input.request);
    const projectId = decodeURIComponent(projectMatch[1]!);
    const payload = (body && typeof body === "object" ? body : {}) as Record<
      string,
      unknown
    >;
    if (
      payload.archived !== undefined &&
      typeof payload.archived !== "boolean"
    ) {
      throw new RequestError(
        400,
        "invalid_request",
        "Project update contains unsupported fields.",
      );
    }
    if (payload.archived === true) {
      return json(
        apiEnvelope<ProjectActionResult>(
          projectLifecycleActionWithAuthorityClose({
            authority: input.authority,
            store: input.store,
            projectId,
            action: "archive",
            metadata: {
              displayName: typeof payload.display_name === "string"
                ? payload.display_name
                : undefined,
              pinned: typeof payload.pinned === "boolean"
                ? payload.pinned
                : undefined,
            },
          }),
        ),
      );
    }
    return json(
      apiEnvelope<ProjectActionResult>(
        input.store.updateProject(projectId, body && typeof body === "object" ? body : {}),
      ),
    );
  }
  const projectArchiveMatch =
    input.request.method === "POST"
      ? url.pathname.match(/^\/projects\/([^/]+)\/archive$/u)
      : null;
  if (projectArchiveMatch) {
    return json(
      apiEnvelope<ProjectActionResult>(
        projectLifecycleActionWithAuthorityClose({
          authority: input.authority,
          store: input.store,
          projectId: decodeURIComponent(projectArchiveMatch[1]!),
          action: "archive",
        }),
      ),
    );
  }
  const projectPinMatch =
    input.request.method === "POST"
      ? url.pathname.match(/^\/projects\/([^/]+)\/pin$/u)
      : null;
  if (projectPinMatch) {
    const body = await parseJson(input.request);
    const pinned =
      body &&
      typeof body === "object" &&
      "pinned" in body &&
      typeof body.pinned === "boolean"
        ? body.pinned
        : undefined;
    return json(
      apiEnvelope<ProjectActionResult>(
        input.store.pinProject(decodeURIComponent(projectPinMatch[1]!), pinned),
      ),
    );
  }
  if (input.request.method === "DELETE" && projectMatch) {
    const permanent = url.searchParams.get("permanent") === "true";
    return json(
      apiEnvelope<ProjectActionResult>(
        projectLifecycleActionWithAuthorityClose({
          authority: input.authority,
          store: input.store,
          projectId: decodeURIComponent(projectMatch[1]!),
          action: permanent ? "permanent_delete" : "delete",
        }),
      ),
    );
  }
  if (input.request.method === "GET" && url.pathname === "/sessions") {
    const kind = url.searchParams.get("kind");
    const normalizedKind =
      kind === "chat" || kind === "project" ? kind : undefined;
    return json(
      apiEnvelope<SessionListView>(
        input.store.listSessions({
          kind: normalizedKind,
          projectId: url.searchParams.get("project_id") ?? undefined,
        }),
      ),
    );
  }
  if (input.request.method === "POST" && url.pathname === "/sessions") {
    const body = await parseJson(input.request);
    if (!isCreateSessionRequest(body))
      throw new RequestError(
        400,
        "invalid_request",
        "Session kind is required.",
      );
    const created = input.store.createSession(body, { emitCreated: false });
    try {
      await input.store.provisionProjectSessionWorktree(
        created.session.id,
        input.serverShutdownSignal,
      );
    } catch (error) {
      input.store.rollbackSessionCreation(created.session.id);
      throw error;
    }
    input.store.publishSessionCreated(created.session.id);
    return json(apiEnvelope<CreateSessionResult>(created), 201);
  }
  const sessionMatch = url.pathname.match(/^\/sessions\/([^/]+)$/u);
  if (input.request.method === "PATCH" && sessionMatch) {
    const body = await parseJson(input.request);
    if (!isUpdateSessionRequest(body)) {
      throw new RequestError(
        400,
        "invalid_session_update",
        "Session update contains unsupported fields.",
      );
    }
    const sessionId = decodeURIComponent(sessionMatch[1]!);
    if (body.archived === true) {
      return json(
        apiEnvelope<SessionActionResult>(
          sessionLifecycleStopWithAuthorityClose({
            authority: input.authority,
            store: input.store,
            sessionId,
            stop: "archive",
            metadata: body.title === undefined ? undefined : { title: body.title },
          }),
        ),
      );
    }
    return json(
      apiEnvelope<SessionActionResult>(
        input.store.updateSession(sessionId, body),
      ),
    );
  }
  const sessionArchiveMatch = url.pathname.match(
    /^\/sessions\/([^/]+)\/archive$/u,
  );
  if (input.request.method === "POST" && sessionArchiveMatch) {
    return json(
      apiEnvelope<SessionActionResult>(
        sessionLifecycleStopWithAuthorityClose({
          authority: input.authority,
          store: input.store,
          sessionId: decodeURIComponent(sessionArchiveMatch[1]!),
          stop: "archive",
        }),
      ),
    );
  }
  if (input.request.method === "DELETE" && sessionMatch) {
    const permanent = url.searchParams.get("permanent") === "true";
    return json(
      apiEnvelope<SessionActionResult>(
        sessionLifecycleStopWithAuthorityClose({
          authority: input.authority,
          store: input.store,
          sessionId: decodeURIComponent(sessionMatch[1]!),
          stop: permanent ? "permanent_delete" : "archive",
        }),
      ),
    );
  }
  const sessionControlsMatch = url.pathname.match(
    /^\/sessions\/([^/]+)\/controls$/u,
  );
  if (input.request.method === "GET" && sessionControlsMatch) {
    return json(
      apiEnvelope<SessionControlsView>(
        input.store.getSessionControlsView(
          decodeURIComponent(sessionControlsMatch[1]!),
        ),
      ),
    );
  }
  if (input.request.method === "PATCH" && sessionControlsMatch) {
    const body = await parseJson(input.request);
    if (!isSessionControlUpdateRequest(body)) {
      throw new RequestError(
        400,
        "invalid_session_controls",
        "Session controls update contains unsupported fields.",
      );
    }
    return json(
      apiEnvelope<SessionControlsView>(
        input.store.updateSessionControlsView(
          decodeURIComponent(sessionControlsMatch[1]!),
          body,
        ),
      ),
    );
  }
  if (input.request.method === "GET" && url.pathname === "/project-sessions") {
    return json(
      apiEnvelope<ProjectSessionListView>(
        input.store.listProjectSessions(
          url.searchParams.get("project_id") ?? undefined,
        ),
      ),
    );
  }
  return null;
}

const RECENT_ARTIFACT_LIMIT = 3;
const WORK_STATUS_TEXT_LIMIT = 180;

function enrichWorkStatusFromConversation(
  store: AppServerStore,
  view: WorkStatusView,
): WorkStatusView {
  return {
    ...view,
    items: view.items.map((item) => enrichWorkStatusItem(store, item)),
  };
}

function enrichWorkStatusItem(
  store: AppServerStore,
  item: WorkStatusItemView,
): WorkStatusItemView {
  const messages = store.listConversationProjectionMessages(
    conversationSessionIdForDurableSession(item.session_id),
  );
  const delivered = messages.filter((message) =>
    message.role === "assistant" && message.status === "delivered",
  );
  const artifacts = delivered.flatMap((message) => message.artifacts ?? []);
  const internalRefs = [
    item.session_id,
    ...messages.flatMap((message) => [
      message.id,
      message.chat_id,
      message.turn_id,
      message.conversation_session_id,
      message.conversation_turn_id,
      message.conversation_message_id,
    ]),
    ...artifacts.flatMap((artifact) => [
      artifact.id,
      artifact.session_id,
      artifact.project_id,
      artifact.message_id,
      artifact.turn_id,
      artifact.file_id,
    ]),
  ].filter((value): value is string => Boolean(value));
  const latestReport = delivered.findLast((message) => message.text.trim());
  const recentArtifacts = uniqueStrings(
    artifacts.map((artifact) => safeConversationLabel(artifact.title, internalRefs)),
  ).slice(-RECENT_ARTIFACT_LIMIT);
  return {
    ...item,
    ...(latestReport
      ? {
        latest_report_summary: safeConversationLabel(
          latestReport.text,
          internalRefs,
          "A recent report is available.",
        ),
      }
      : {}),
    ...(recentArtifacts.length > 0 ? { recent_artifacts: recentArtifacts } : {}),
  };
}

function safeConversationLabel(
  value: string,
  internalRefs: string[],
  fallback = "Artifact",
): string {
  let text = value;
  for (
    const ref of [...new Set(internalRefs)].sort((left, right) =>
      right.length - left.length,
    )
  ) {
    text = text.split(ref).join("internal reference");
  }
  text = text.replace(/!?(?:\[([^\]]*)\])\([^)]*\)/gu, "$1")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/giu, "reference")
    .replace(
      /(?:\/Users|\/home|\/private|\/var|\/tmp|\/Volumes|\/opt|\/usr|\/etc)\/[^\s),;]+/gu,
      "local reference",
    )
    .replace(/(?:~\/|\$HOME\/)[^\s),;]+/gu, "local reference")
    .replace(/\b[A-Za-z]:\\[^\s),;]+/gu, "local reference")
    .replace(/\\\\[^\s\\]+\\[^\s),;]+/gu, "local reference")
    .replace(/\b(?:packages|src|tests|docs|project-ledger)\/[^\s),;]+/gu, "local reference")
    .replace(
      /\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/giu,
      "internal reference",
    )
    .replace(/\b[0-9a-f]{24,}\b/giu, "internal reference")
    .trim();
  const safeText = sanitizePublicText(text, fallback);
  return safeText.length > WORK_STATUS_TEXT_LIMIT
    ? `${safeText.slice(0, WORK_STATUS_TEXT_LIMIT - 3)}...`
    : safeText;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
