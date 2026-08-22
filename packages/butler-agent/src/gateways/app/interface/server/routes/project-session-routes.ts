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
} from "../../protocol/app-protocol.ts";
import { paginationFromSearchParams } from "../route-params.ts";
import { json, parseJson, RequestError } from "../responses.ts";

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
    return json(
      apiEnvelope<ProjectActionResult>(
        input.store.updateProject(
          decodeURIComponent(projectMatch[1]!),
          body && typeof body === "object" ? body : {},
        ),
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
        input.store.archiveProject(decodeURIComponent(projectArchiveMatch[1]!)),
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
    return json(
      apiEnvelope<ProjectActionResult>(
        url.searchParams.get("permanent") === "true"
          ? input.store.deleteProjectPermanent(decodeURIComponent(projectMatch[1]!))
          : input.store.deleteProject(decodeURIComponent(projectMatch[1]!)),
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
    return json(
      apiEnvelope<SessionActionResult>(
        input.store.updateSession(decodeURIComponent(sessionMatch[1]!), body),
      ),
    );
  }
  const sessionArchiveMatch = url.pathname.match(
    /^\/sessions\/([^/]+)\/archive$/u,
  );
  if (input.request.method === "POST" && sessionArchiveMatch) {
    return json(
      apiEnvelope<SessionActionResult>(
        input.store.archiveSession(decodeURIComponent(sessionArchiveMatch[1]!)),
      ),
    );
  }
  if (input.request.method === "DELETE" && sessionMatch) {
    return json(
      apiEnvelope<SessionActionResult>(
        url.searchParams.get("permanent") === "true"
          ? input.store.deleteSessionPermanent(decodeURIComponent(sessionMatch[1]!))
          : input.store.archiveSession(decodeURIComponent(sessionMatch[1]!)),
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
