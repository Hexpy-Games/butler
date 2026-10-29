/** Exact canon route allowlist; the preload retains ownership of authenticated requests. */
export function canonBridgeInput(url: URL, verb: string, body: () => Record<string, unknown>): { method: string; input: Record<string, unknown> } | null {
  if (url.pathname === "/canon/mcp-grants" && verb === "GET") return { method: "getCanonGrants", input: { state: url.searchParams.get("state") } };
  const grant = url.pathname.match(/^\/canon\/mcp-grants\/([^/]+)\/(allow|deny|revoke)$/u);
  if (grant && verb === "POST") return { method: "decideCanonGrant", input: { id: decodeURIComponent(grant[1]!), action: grant[2] } };
  const criterion = url.pathname.match(/^\/canon\/specs\/([^/]+)\/criteria\/([^/]+)$/u);
  if (criterion && verb === "POST") return { method: "checkCanonCriterion", input: { id: decodeURIComponent(criterion[1]!), criterionId: decodeURIComponent(criterion[2]!), body: body() } };
  const activity = url.pathname.match(/^\/canon\/epics\/([^/]+)\/activity$/u);
  if (activity && verb === "GET") return { method: "getCanonActivity", input: { id: decodeURIComponent(activity[1]!), before: url.searchParams.get("before") } };
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
