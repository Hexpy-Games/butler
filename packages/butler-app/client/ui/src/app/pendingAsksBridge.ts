/** Authenticated desktop routes for the pending ask read projection. */
export function pendingAsksBridgeInput(url: URL, method: string): { method: string; input: Record<string, unknown> } | null {
  if (method === "GET" && url.pathname === "/pending-asks") {
    return { method: "getPendingAsks", input: {
      limit: url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined,
      before: url.searchParams.get("before") ?? undefined,
    } };
  }
  const session = url.pathname.match(/^\/sessions\/([^/]+)\/pending-asks$/u);
  if (method === "GET" && session) {
    return { method: "getSessionPendingAsks", input: { sessionId: decodeURIComponent(session[1]!) } };
  }
  const dismiss = url.pathname.match(/^\/sessions\/([^/]+)\/pending-asks\/([^/]+)\/dismiss$/u);
  if (method === "POST" && dismiss) {
    return { method: "dismissPendingAsk", input: { sessionId: decodeURIComponent(dismiss[1]!), askId: decodeURIComponent(dismiss[2]!) } };
  }
  return null;
}
