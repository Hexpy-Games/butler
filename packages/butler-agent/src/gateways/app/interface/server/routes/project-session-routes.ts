import {
  apiEnvelope,
  isCreateProjectRequest,
  isCreateSessionRequest,
  isPlanDecisionRequest,
  isSessionControlUpdateRequest,
  isUpdateSessionRequest,
  type ArchiveListView,
  type CreateProjectResult,
  type CreateSessionResult,
  type NavigationView,
  type NewChatBriefingView,
  type ProjectActionResult,
  type ProjectDashboardView,
  type PlanDecisionResult,
  type ProjectListView,
  type ProjectSessionListView,
  type SessionActionResult,
  type SessionControlsView,
  type SessionListView,
  type WorkStatusItemView,
  type WorkStatusView,
} from "../../protocol/app-protocol.ts";
import type { AppServerStore } from "../../../application/store/app-server-store.ts";
import { attachProjectArtifact } from "../../../domain/projects/project-artifact-attachment.ts";
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
        await input.store.getNewChatBriefing({
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
  const preferencesMatch = input.request.method === "PATCH" ? url.pathname.match(/^\/projects\/([^/]+)\/dashboard\/preferences$/u) : null;
  const attachmentMatch = input.request.method === "POST" ? url.pathname.match(/^\/projects\/([^/]+)\/dashboard\/attachment$/u) : null;
  if (attachmentMatch) {
    const body = await parseJson(input.request) as Record<string, unknown> | null;
    if (!body || typeof body.id !== "string" || body.id.length > 256 || typeof body.revision !== "string" ||
        !/^[a-f0-9]{64}$/u.test(body.revision) || Object.keys(body).some((key) => !["id", "revision"].includes(key))) {
      throw new RequestError(400, "invalid_request", "Invalid artifact reference.");
    }
    return json(apiEnvelope(await attachProjectArtifact(input.store, decodeURIComponent(attachmentMatch[1]!), body.id, body.revision)), 201);
  }
  const statisticsMatch = input.request.method === "GET" ? url.pathname.match(/^\/projects\/([^/]+)\/dashboard\/statistics$/u) : null;
  if (statisticsMatch) {
    const days = Number(url.searchParams.get("days") ?? 30);
    if (![7, 30, 90].includes(days)) throw new RequestError(400, "invalid_statistics_query", "Invalid period.");
    return json(apiEnvelope(await input.store.getProjectDashboardStatistics(decodeURIComponent(statisticsMatch[1]!),
      days as 7 | 30 | 90, url.searchParams.get("timezone") ?? "")));
  }
  const briefingMatch = input.request.method === "POST" ? url.pathname.match(/^\/projects\/([^/]+)\/dashboard\/briefing$/u) : null;
  if (briefingMatch) {
    const body = await parseJson(input.request) as Record<string, unknown> | null;
    if (!body || typeof body.sourceRevision !== "string" || !/^[a-f0-9]{64}$/u.test(body.sourceRevision) ||
        (body.retry !== undefined && typeof body.retry !== "boolean") || Object.keys(body).some((key) => !["sourceRevision", "retry"].includes(key))) {
      throw new RequestError(400, "invalid_request", "Invalid briefing request.");
    }
    return json(apiEnvelope(await input.store.requestProjectDashboardBriefing(decodeURIComponent(briefingMatch[1]!), body.sourceRevision, body.retry === true)), 202);
  }
  if (preferencesMatch) {
    const projectId = decodeURIComponent(preferencesMatch[1]!);
    const body = await parseJson(input.request) as Record<string, unknown> | null;
    if (!body || !Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 0 ||
        Object.keys(body).some((key) => !["expectedRevision", "description", "pinnedSourceRefs"].includes(key)) ||
        (body.description !== undefined && (typeof body.description !== "string" || body.description.length > 2000)) ||
        (body.description === undefined && body.pinnedSourceRefs === undefined)) {
      throw new RequestError(400, "invalid_request", "Invalid preferences patch.");
    }
    let pins: Array<{ kind: string; id: string; revision: string }> | undefined;
    if (body.pinnedSourceRefs !== undefined) {
      if (!Array.isArray(body.pinnedSourceRefs) || body.pinnedSourceRefs.length > 12) throw new RequestError(400, "invalid_request", "Invalid sources.");
      pins = [];
      const current = await input.store.getProjectDashboard(projectId);
      if (!current.preferences || current.preferences.revision !== body.expectedRevision) throw new RequestError(409, "preferences_changed", "Preferences changed. Reload them.");
      for (const ref of body.pinnedSourceRefs) {
        if (!ref || typeof ref !== "object" || !["work", "task", "plan", "spec", "report", "artifact"].includes(ref.kind) ||
            typeof ref.id !== "string" || !ref.id || ref.id.length > 256 || typeof ref.revision !== "string" ||
            !/^[a-f0-9]{64}$/u.test(ref.revision) || pins.some((pin) => pin.kind === ref.kind && pin.id === ref.id)) {
          throw new RequestError(400, "invalid_request", "Invalid source reference.");
        }
        const retained = current.preferences.pinnedSourceRefs.find((pin) => pin.kind === ref.kind && pin.id === ref.id && pin.revision === ref.revision);
        const source = retained ? null : await input.store.getProjectDashboardSource(projectId, ref);
        pins.push({ kind: ref.kind, id: ref.id, revision: source?.revision ?? ref.revision });
      }
    }
    return json(apiEnvelope(input.store.updateProjectDashboardPreferences(projectId, {
      expectedRevision: Number(body.expectedRevision), description: body.description as string | undefined, pinnedSourceRefs: pins,
    })));
  }
  const boardMatch = input.request.method === "GET" ? url.pathname.match(/^\/projects\/([^/]+)\/dashboard\/records$/u) : null;
  if (boardMatch) {
    const kind = url.searchParams.get("kind") ?? "work";
    const lane = url.searchParams.get("lane") ?? undefined;
    if (lane && !["planned", "active", "review", "blocked", "done", "other"].includes(lane)) {
      throw new RequestError(400, "invalid_request", "Invalid board lane.");
    }
    const limit = Number(url.searchParams.get("limit") ?? 50);
    const cursor = url.searchParams.get("cursor") ?? undefined;
    if (!["work", "plan", "task"].includes(kind) || !Number.isInteger(limit) || limit < 1 || limit > 100 ||
        (cursor?.length ?? 0) > 2048) throw new RequestError(400, "invalid_request", "Invalid board query.");
    return json(apiEnvelope(await input.store.getProjectDashboardBoard(decodeURIComponent(boardMatch[1]!), {
      kind: kind as "work" | "plan" | "task", limit, cursor, parent: url.searchParams.get("parent") ?? undefined,
      lane: lane as "planned" | "active" | "review" | "blocked" | "done" | "other" | undefined,
    })));
  }
  const sourceMatch = input.request.method === "GET" ? url.pathname.match(/^\/projects\/([^/]+)\/dashboard\/(materials|source|history|artifacts)$/u) : null;
  if (sourceMatch) {
    const projectId = decodeURIComponent(sourceMatch[1]!);
    const cursor = url.searchParams.get("cursor") ?? undefined;
    if ((cursor?.length ?? 0) > 2048) throw new RequestError(400, "invalid_request", "Invalid cursor.");
    if (sourceMatch[2] === "artifacts") {
      const limit = Number(url.searchParams.get("limit") ?? 50);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RequestError(400, "invalid_request", "Invalid limit.");
      return json(apiEnvelope(input.store.getProjectDashboardArtifacts(projectId, { cursor, limit })));
    }
    if (sourceMatch[2] === "history") {
      const limit = Number(url.searchParams.get("limit") ?? 50);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RequestError(400, "invalid_request", "Invalid limit.");
      return json(apiEnvelope(await input.store.getProjectDashboardHistory(projectId, { cursor, limit })));
    }
    if (sourceMatch[2] === "materials") {
      const limit = Number(url.searchParams.get("limit") ?? 50);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RequestError(400, "invalid_request", "Invalid limit.");
      return json(apiEnvelope(await input.store.getProjectDashboardMaterials(projectId, {
        cursor, limit, all: url.searchParams.get("all") === "true", important: url.searchParams.get("important") === "true",
      })));
    }
    const kind = url.searchParams.get("kind") ?? "";
    const id = url.searchParams.get("id") ?? "";
    const revision = url.searchParams.get("revision") ?? "";
    if (!["work", "task", "plan", "spec", "report", "message", "reference", "artifact"].includes(kind) || !id || id.length > 256 || !revision || revision.length > 256) {
      throw new RequestError(400, "invalid_request", "Invalid source query.");
    }
    return json(apiEnvelope(await input.store.getProjectDashboardSource(projectId, { kind, id, revision, cursor })));
  }
  if (projectDashboardMatch) {
    return json(
      apiEnvelope<ProjectDashboardView>(
        await input.store.getProjectDashboard(
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
  const planDecisionMatch = input.request.method === "POST"
    ? url.pathname.match(/^\/sessions\/([^/]+)\/plan-decisions\/([^/]+)$/u)
    : null;
  if (planDecisionMatch) {
    const body = await parseJson(input.request);
    if (!isPlanDecisionRequest(body)) {
      throw new RequestError(
        400,
        "invalid_plan_decision",
        "Plan decision action is required.",
      );
    }
    return json(
      apiEnvelope<PlanDecisionResult>(
        await input.store.decideSessionPlan(
          decodeURIComponent(planDecisionMatch[1]!),
          decodeURIComponent(planDecisionMatch[2]!),
          body,
        ),
      ),
    );
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
