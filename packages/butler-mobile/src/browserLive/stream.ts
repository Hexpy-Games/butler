import type { Route } from "@/connection/route";

export function openLiveFrames(route: Route, token: string, tab: string, width: number, signal: AbortSignal) {
  return route.fetch(`${route.origin}/browser/tabs/${encodeURIComponent(tab)}/live?width=${width}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, accept: "application/vnd.butler.browser-live" },
    signal,
  });
}
