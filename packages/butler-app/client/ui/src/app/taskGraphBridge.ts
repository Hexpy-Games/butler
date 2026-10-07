/** Routes through the existing authenticated desktop preload API. */
export function taskGraphBridgeInput(url: URL): { method: string; input: Record<string, unknown> } | null {
  const match = url.pathname.match(/^\/(sessions|plans|tasks)\/([^/]+)\/(task-graphs|task-graph|document)$/u);
  if (!match) return null;
  const method = { sessions: "getSessionTaskGraphs", plans: "getPlanTaskGraph", tasks: "getTaskDocument" }[match[1] as "sessions" | "plans" | "tasks"];
  return { method, input: { id: decodeURIComponent(match[2]!), revision: url.searchParams.get("revision") ?? undefined, cursor: url.searchParams.get("cursor") ?? undefined, limit: url.searchParams.get("limit") ?? undefined } };
}
