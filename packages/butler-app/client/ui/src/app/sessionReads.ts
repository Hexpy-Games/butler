import { api } from "./api.ts";
import { isServerBackedSessionId } from "./sessionIds.ts";
import { useButlerStore } from "./store.ts";
import type { NavigationView, SessionSummary } from "./types.ts";

/** The navigation with `sessionId` read; the same object when nothing changed. */
export function navigationWithSessionRead(
  navigation: NavigationView,
  sessionId: string,
): NavigationView {
  const read = (session: SessionSummary) =>
    session.id === sessionId && session.unread ? { ...session, unread: false } : session;
  const chats = navigation.chats.map(read);
  let changed = chats.some((session, index) => session !== navigation.chats[index]);
  const projects = navigation.projects.map((project) => {
    const sessions = project.sessions?.map(read);
    if (!sessions?.some((session, index) => session !== project.sessions![index])) return project;
    changed = true;
    return { ...project, sessions };
  });
  return changed ? { ...navigation, chats, projects } : navigation;
}

/**
 * Clears the dot locally. A navigation load that started before the read
 * would bring it back, so the read also fences those loads.
 */
export function applySessionRead(sessionId: string): void {
  const state = useButlerStore.getState();
  state.noteNavigationEvent();
  const navigation = navigationWithSessionRead(state.navigation, sessionId);
  if (navigation !== state.navigation) useButlerStore.setState({ navigation });
}

const reading = new Set<string>();

/**
 * Records that the user saw the session's latest reply: one request per
 * unread state, never per streamed delta. The gateway writes only when the
 * marker moves and tells other devices with `session.read`.
 */
export async function markSessionRead(sessionId: string): Promise<void> {
  if (!isServerBackedSessionId(sessionId) || reading.has(sessionId)) return;
  reading.add(sessionId);
  applySessionRead(sessionId);
  try {
    await api(`/sessions/${encodeURIComponent(sessionId)}/read`, { method: "POST", body: "{}" });
  } catch {
    // The next navigation load shows the dot again, and viewing retries.
  } finally {
    reading.delete(sessionId);
  }
}
