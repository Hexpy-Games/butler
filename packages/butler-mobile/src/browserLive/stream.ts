import type { Route } from "@/connection/route";

export function openLiveFrames(route: Route, token: string, tab: string, viewport: { width: number; height: number; dpr: number }, signal: AbortSignal) {
  return route.fetch(`${route.origin}/browser/tabs/${encodeURIComponent(tab)}/live?width=${viewport.width}&height=${viewport.height}&dpr=${viewport.dpr}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, accept: "application/vnd.butler.browser-live" },
    signal,
  });
}
