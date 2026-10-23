/** Exact canon route allowlist; the preload retains ownership of authenticated requests. */
export function canonBridgeInput(url: URL, verb: string, body: () => Record<string, unknown>): { method: string; input: Record<string, unknown> } | null {
  const project = url.pathname.match(/^\/projects\/([^/]+)\/canon(?:\/(plans|epics|backlog\/order))?$/u);
  if (project) {
    const method = verb === "GET" && !project[2] ? "getCanon" : verb === "POST" ?
      ({ plans: "createCanonPlan", epics: "createCanonEpic", "backlog/order": "orderCanonBacklog" }[project[2] ?? ""]) : undefined;
    return method ? { method, input: { id: decodeURIComponent(project[1]!), body: body() } } : null;
  }
  const entity = url.pathname.match(/^\/canon\/(plans|epics)\/([^/]+)(\/order)?$/u);
  if (entity) {
    const plan = entity[1] === "plans";
    const method = entity[3] ? plan && verb === "POST" ? "orderCanonPlan" : undefined :
      verb === "GET" ? plan ? "getCanonPlan" : "getCanonEpic" : verb === "PATCH" ? plan ? "editCanonPlan" : "editCanonEpic" : undefined;
    return method ? { method, input: { id: decodeURIComponent(entity[2]!), body: body() } } : null;
  }
  const tasks = verb === "GET" ? url.pathname.match(/^\/works\/([^/]+)\/tasks$/u) : null;
  return tasks ? { method: "getWorkTasks", input: { id: decodeURIComponent(tasks[1]!) } } : null;
}
