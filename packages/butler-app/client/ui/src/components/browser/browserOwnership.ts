import type { NavigationView } from "@/app/types";

/** Only canonical navigation conversations may own visible browser groups or docking. */
export function publicBrowserOwner(owner: string, navigation: NavigationView): string | undefined {
  if (!owner.startsWith("conversation:")) return undefined;
  const id = owner.slice(13);
  return navigation.chats.some((session) => session.id === id)
    || navigation.projects.some((project) => project.sessions?.some((session) => session.id === id))
    ? id : undefined;
}

type ConversationTab = { id: string; waiting?: boolean; busy?: boolean; agentAt?: number };

/**
 * The tab a conversation's browser opens on: one that needs you, then the one Butler is working in or
 * worked in last, then the one you last viewed, then the first. None while the group has no tabs.
 */
export function relevantConversationTab<T extends ConversationTab>(tabs: readonly T[], remembered?: string): T | undefined {
  const latest = tabs.reduce<T | undefined>((best, tab) => (tab.agentAt ?? 0) > (best?.agentAt ?? 0) ? tab : best, undefined);
  return tabs.find((tab) => tab.waiting) ?? tabs.find((tab) => tab.busy) ?? latest
    ?? tabs.find((tab) => tab.id === remembered) ?? tabs[0];
}
