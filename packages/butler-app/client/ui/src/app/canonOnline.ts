import { useEffect } from "react";
import { create } from "zustand";
import { api } from "./api.ts";
import type { CanonOnlineAction, CanonOnlineLink, CanonOnlineStatus } from "./canonApi.ts";
import { singleFlight } from "./canonEvents.ts";
import { appCopy, useAppLocale } from "./copy.ts";

export function getCanonOnline(): Promise<CanonOnlineStatus> {
  return api("/setup/canon-online");
}

export function postCanonOnline<T>(action: CanonOnlineAction): Promise<T> {
  return api("/setup/canon-online", { method: "POST", body: JSON.stringify(action) });
}

export const useCanonOnlineStore = create<{
  available: boolean;
  loaded: boolean;
  links: Record<string, CanonOnlineLink>;
  refresh: () => Promise<void>;
}>(set => ({
  available: false,
  loaded: false,
  links: {},
  refresh: singleFlight(async () => {
    try {
      const { links } = await getCanonOnline();
      set({ available: true, loaded: true, links: Object.fromEntries(links.map(link => [link.project_id, link])) });
    } catch {
      set({ available: false, loaded: true, links: {} });
    }
  }),
}));

export function useCanonOnlineAvailable(): boolean {
  const available = useCanonOnlineStore(state => state.available);
  useEffect(() => {
    const { loaded, refresh } = useCanonOnlineStore.getState();
    if (!loaded) void refresh();
  }, []);
  return available;
}

export function useCanonOnlineLink(projectId: string, { poll = false } = {}): CanonOnlineLink | undefined {
  const link = useCanonOnlineStore(state => state.links[projectId]);
  const hasLink = Boolean(link);
  useEffect(() => {
    const { loaded, refresh } = useCanonOnlineStore.getState();
    if (!loaded) void refresh();
  }, []);
  useEffect(() => {
    if (!poll || !hasLink) return;
    const { refresh } = useCanonOnlineStore.getState();
    const refreshVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    const interval = window.setInterval(refreshVisible, 5000);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshVisible);
    };
  }, [hasLink, poll, projectId]);
  return link;
}

export function useCanonOnlineLock(projectId: string): string | undefined {
  useAppLocale();
  const link = useCanonOnlineLink(projectId);
  const copy = appCopy.canon.online;
  if (link?.state === "detached") return copy.lockedDetached;
  if (link?.role === "viewer") return copy.lockedViewer;
}

export function canonOnlineState(link: CanonOnlineLink): "connected" | "offline" | "error" | "detached" {
  return link.state === "detached" ? "detached" : link.connection;
}
