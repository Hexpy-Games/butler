import type {
  ChatKind,
  MessageRecord,
  NavigationView,
  SessionSummary,
  SessionSummaryView,
} from "./types.ts";

const OPTIMISTIC_SESSION_PREFIX = "optimistic:session:";

export interface OptimisticSessionStart {
  id: string;
  kind: ChatKind;
  projectId?: string;
  title: string;
  statusLabel: string;
  startedAt: string;
}

export function optimisticSessionId(clientMessageId: string): string {
  return `${OPTIMISTIC_SESSION_PREFIX}${clientMessageId}`;
}

export function isOptimisticSessionId(value: string): boolean {
  return value.startsWith(OPTIMISTIC_SESSION_PREFIX);
}

export function optimisticSessionSummary(
  session: OptimisticSessionStart,
): SessionSummary {
  return {
    id: session.id,
    kind: session.kind,
    title: session.statusLabel,
    project_id: session.projectId,
    last_activity_at: session.startedAt,
    active_turn_state: "session_starting",
    pinned: false,
    archived: false,
  };
}

export function navigationWithOptimisticSession(
  navigation: NavigationView,
  session: OptimisticSessionStart | null,
): NavigationView {
  if (!session) return navigation;
  const optimistic = optimisticSessionSummary(session);
  if (session.kind === "project" && session.projectId) {
    return {
      ...navigation,
      projects: navigation.projects.map((project) =>
        project.id === session.projectId
          ? {
              ...project,
              sessions: upsertSessionSummary(project.sessions ?? [], optimistic),
            }
          : project,
      ),
    };
  }
  return {
    ...navigation,
    chats: upsertSessionSummary(navigation.chats ?? [], optimistic),
  };
}

export function navigationReplacingOptimisticSession(
  navigation: NavigationView,
  optimisticId: string,
  session: SessionSummary,
): NavigationView {
  const replace = (sessions: SessionSummary[] = []) =>
    upsertSessionSummary(
      sessions.filter((item) => item.id !== optimisticId),
      session,
    );
  if (session.kind === "project" && session.project_id) {
    return {
      ...navigation,
      projects: navigation.projects.map((project) =>
        project.id === session.project_id
          ? { ...project, sessions: replace(project.sessions ?? []) }
          : project,
      ),
    };
  }
  return {
    ...navigation,
    chats: replace(navigation.chats ?? []),
  };
}

export function findSessionSummary(
  navigation: NavigationView,
  sessionId: string,
): SessionSummary | null {
  const chat = navigation.chats.find((session) => session.id === sessionId);
  if (chat) return chat;
  for (const project of navigation.projects) {
    const session = project.sessions?.find((item) => item.id === sessionId);
    if (session) return session;
  }
  return null;
}

export function navigationWithSessionSummary(
  navigation: NavigationView,
  session: SessionSummary,
): NavigationView {
  if (session.kind === "project" && session.project_id) {
    return {
      ...navigation,
      projects: navigation.projects.map((project) =>
        project.id === session.project_id
          ? {
              ...project,
              sessions: upsertSessionSummary(project.sessions ?? [], session),
            }
          : project,
      ),
    };
  }
  return {
    ...navigation,
    chats: upsertSessionSummary(navigation.chats ?? [], session),
  };
}

export function navigationWithoutOptimisticSession(
  navigation: NavigationView,
  optimisticId: string,
): NavigationView {
  return {
    ...navigation,
    chats: navigation.chats.filter((chat) => chat.id !== optimisticId),
    projects: navigation.projects.map((project) => ({
      ...project,
      sessions: (project.sessions ?? []).filter(
        (session) => session.id !== optimisticId,
      ),
    })),
  };
}

export function messagesWithChatId(
  messages: MessageRecord[],
  previousChatId: string,
  nextChatId: string,
): MessageRecord[] {
  return messages.map((message) =>
    message.chat_id === previousChatId
      ? { ...message, chat_id: nextChatId }
      : message,
  );
}

export function summaryWithSessionId(
  summary: SessionSummaryView | null,
  previousSessionId: string,
  nextSessionId: string,
): SessionSummaryView | null {
  if (!summary || summary.session_id !== previousSessionId) return summary;
  return { ...summary, session_id: nextSessionId };
}

function upsertSessionSummary(
  sessions: SessionSummary[],
  session: SessionSummary,
): SessionSummary[] {
  const withoutCurrent = sessions.filter((item) => item.id !== session.id);
  return [session, ...withoutCurrent];
}
