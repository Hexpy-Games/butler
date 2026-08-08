import type { NavigationView, SessionSummary, TimelineEvent } from "../../app/types.ts";
import {
  compareTimestamp,
  isRecord,
  safeSessionSummary,
  sessionIdFromEvent,
  timestampMs,
} from "./liveNavigationSessionPolicy.ts";

const NAVIGATION_EVENT_TYPES = new Set([
  "session.created",
  "session.updated",
  "session.permanently_deleted",
]);

export function isNavigationEvent(event: TimelineEvent): boolean {
  return NAVIGATION_EVENT_TYPES.has(event.type);
}

export function isProjectNavigationEvent(event: TimelineEvent): boolean {
  if (event.type === "session.permanently_deleted") return true;
  if (event.type !== "session.created" && event.type !== "session.updated") return false;
  const session = event.payload?.session;
  return isRecord(session) && session.kind === "project" &&
    typeof session.project_id === "string" && Boolean(session.project_id.trim());
}

export function applyLiveNavigationEvent(
  navigation: NavigationView,
  event: TimelineEvent,
): NavigationView {
  if (!isNavigationEvent(event)) return navigation;
  if (event.type === "session.permanently_deleted") {
    const sessionId = sessionIdFromEvent(event);
    if (!sessionId) return navigation;
    return removeSession(navigation, sessionId);
  }

  const incoming = safeSessionSummary(event.payload?.session);
  if (!incoming) return navigation;
  if (incoming.kind !== "project") return navigation;
  if (!incoming.project_id) return navigation;
  const projectIndex = navigation.projects.findIndex(
    (project) => project.id === incoming.project_id,
  );
  if (projectIndex < 0) return navigation;
  const project = navigation.projects[projectIndex]!;
  const sessions = project.sessions ?? [];
  const currentIndex = sessions.findIndex((session) => session.id === incoming.id);
  const current = currentIndex >= 0 ? sessions[currentIndex] : undefined;
  const existingLocation = findSessionLocation(navigation, incoming.id);
  if (
    !current && existingLocation &&
    (existingLocation.kind !== "project" || existingLocation.projectId !== incoming.project_id)
  ) return navigation;
  if (current && current.kind !== incoming.kind) return navigation;
  // An update for a row that is no longer present cannot safely recreate it.
  // The bounded canonical navigation refresh owns that recovery path; only a
  // created event may insert an absent session into an existing project.
  if (!current && event.type === "session.updated") return navigation;

  if (incoming.archived === true) {
    if (current && !isIncomingNewer(current, incoming)) return navigation;
    const next = replaceProjectSessions(navigation, projectIndex, sessions.filter(
      (session) => session.id !== incoming.id,
    ));
    return next;
  }
  if (current && !isIncomingNewer(current, incoming)) return navigation;

  const merged = current ? mergeSessionSummary(current, incoming) : incoming;
  const nextSessions = current
    ? sessions.map((session) => session.id === incoming.id ? merged : session)
    : [...sessions, merged];
  const next = replaceProjectSessions(
    navigation,
    projectIndex,
    sortSessions(nextSessions),
  );
  return next;
}
function mergeSessionSummary(
  current: SessionSummary,
  incoming: SessionSummary,
): SessionSummary {
  return {
    ...current,
    ...incoming,
    project: incoming.project ?? current.project,
    last_activity_at: incoming.last_activity_at ?? current.last_activity_at,
    pinned: incoming.pinned,
    archived: incoming.archived,
  };
}

function isIncomingNewer(current: SessionSummary, incoming: SessionSummary): boolean {
  const currentTimestamp = timestampMs(current.updated_at);
  const incomingTimestamp = timestampMs(incoming.updated_at);
  if (currentTimestamp === null) return incomingTimestamp !== null;
  if (incomingTimestamp === null) return false;
  return incomingTimestamp > currentTimestamp;
}

function sortSessions(sessions: SessionSummary[]): SessionSummary[] {
  return sessions
    .map((session, index) => ({ session, index }))
    .sort((left, right) => {
      const pinned = Number(right.session.pinned) - Number(left.session.pinned);
      if (pinned !== 0) return pinned;
      const updated = compareTimestamp(right.session.updated_at, left.session.updated_at);
      if (updated !== 0) return updated;
      const created = compareTimestamp(right.session.created_at, left.session.created_at);
      return created !== 0 ? created : left.index - right.index;
    })
    .map(({ session }) => session);
}

function replaceProjectSessions(
  navigation: NavigationView,
  projectIndex: number,
  sessions: SessionSummary[],
): NavigationView {
  const next = {
    ...navigation,
    projects: navigation.projects.map((project, index) =>
      index === projectIndex ? { ...project, sessions } : project),
  };
  return next;
}

function removeSession(navigation: NavigationView, sessionId: string): NavigationView {
  let changed = false;
  const chats = navigation.chats.filter((session) => {
    const keep = session.id !== sessionId;
    changed ||= !keep;
    return keep;
  });
  const projects = navigation.projects.map((project) => {
    const sessions = (project.sessions ?? []).filter((session) => {
      const keep = session.id !== sessionId;
      changed ||= !keep;
      return keep;
    });
    return sessions.length === (project.sessions ?? []).length
      ? project
      : { ...project, sessions };
  });
  if (!changed) return navigation;
  return { ...navigation, chats, projects };
}

function findSessionLocation(
  navigation: NavigationView,
  sessionId: string,
): { kind: "chat" | "project"; projectId?: string } | undefined {
  if (navigation.chats.some((session) => session.id === sessionId)) {
    return { kind: "chat" };
  }
  for (const project of navigation.projects) {
    if ((project.sessions ?? []).some((session) => session.id === sessionId)) {
      return { kind: "project", projectId: project.id };
    }
  }
  return undefined;
}
