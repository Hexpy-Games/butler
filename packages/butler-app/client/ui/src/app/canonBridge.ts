/** Exact canon route allowlist; the preload retains ownership of authenticated requests. */
export function canonBridgeInput(url: URL, verb: string, body: () => Record<string, unknown>): { method: string; input: Record<string, unknown> } | null {
  const proposal = url.pathname.match(/^\/canon\/proposals\/([^/]+)$/u);
  if (proposal && (verb === "GET" || verb === "POST")) return {
    method: verb === "GET" ? "getCanonProposal" : "resolveCanonProposal", input: { id: decodeURIComponent(proposal[1]!), body: body() },
  };
  const project = url.pathname.match(/^\/projects\/([^/]+)\/canon(?:\/(plans|epics|tags|backlog\/order|sidebar|sidebar-order))?$/u);
  if (project) {
    const method = verb === "GET" ? (!project[2] ? "getCanon" : project[2] === "sidebar" ? "getCanonSidebar" : project[2] === "tags" ? "getCanonTags" : undefined) : verb === "POST" ?
      ({ tags: "createCanonTag", plans: "createCanonPlan", epics: "createCanonEpic", "backlog/order": "orderCanonBacklog", "sidebar-order": "orderCanonSidebar" }[project[2] ?? ""]) : undefined;
    return method ? { method, input: { id: decodeURIComponent(project[1]!), body: body() } } : null;
  }
  const tag = url.pathname.match(/^\/canon\/tags\/([^/]+)$/u);
  if (tag && (verb === "PATCH" || verb === "DELETE")) {
    return { method: verb === "PATCH" ? "editCanonTag" : "deleteCanonTag", input: { id: decodeURIComponent(tag[1]!), body: body() } };
  }
  const entity = url.pathname.match(/^\/canon\/(plans|epics)\/([^/]+)(\/order|\/conversation|\/progress)?$/u);
  if (entity) {
    const plan = entity[1] === "plans";
    const method = entity[3] === "/progress" ? verb === "GET" && !plan ? "getEpicProgress" : undefined : entity[3] ? verb === "POST" ? (plan && entity[3] === "/order" ? "orderCanonPlan" : !plan && entity[3] === "/conversation" ? "linkCanonConversation" : undefined) : undefined :
      verb === "GET" ? plan ? "getCanonPlan" : "getCanonEpic" : verb === "PATCH" ? plan ? "editCanonPlan" : "editCanonEpic" : undefined;
    if (!method) return null;
    const input = body();
    return { method, input: { id: decodeURIComponent(entity[2]!), ...(method === "linkCanonConversation" ? { sessionId: input.session_id } : { body: input }) } };
  }
  return null;
}
