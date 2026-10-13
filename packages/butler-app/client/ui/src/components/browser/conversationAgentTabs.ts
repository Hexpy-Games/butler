import type { SessionView } from "@/app/types";
import type { BrowserTab } from "./browserBridge";

/** The conversation and its delegated child sessions, parent first. */
export function conversationFamily(session: string, views: Record<string, SessionView>): string[] {
  const sessions = new Set([session]);
  for (const id of sessions) {
    for (const child of views[id]?.steward_children ?? []) {
      if (child.relation.parent_session_id === id) sessions.add(child.relation.child_session_id);
    }
  }
  return [...sessions];
}

/** Presentation roll-up only: tabs retain their executor ownership and control scope. */
export function familyAgentTabs(family: readonly string[], tabs: BrowserTab[]): BrowserTab[] {
  const sessions = new Set(family);
  return tabs.filter((tab) => (tab.agent || tab.driven) && tab.owner.startsWith("conversation:") && sessions.has(tab.owner.slice(13)));
}

export function conversationAgentTabs(session: string, tabs: BrowserTab[], views: Record<string, SessionView>): BrowserTab[] {
  return familyAgentTabs(conversationFamily(session, views), tabs);
}
