import type { NavigationView } from "@/app/types";

/** Only canonical navigation conversations may own visible browser groups or docking. */
export function publicBrowserOwner(owner: string, navigation: NavigationView): string | undefined {
  if (!owner.startsWith("conversation:")) return undefined;
  const id = owner.slice(13);
  return navigation.chats.some((session) => session.id === id)
    || navigation.projects.some((project) => project.sessions?.some((session) => session.id === id))
    ? id : undefined;
}
