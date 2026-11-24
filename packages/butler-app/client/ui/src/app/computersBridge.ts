/** Settings → Security → Other computers: main adds the admin credential. */
export function computerBridgeCall(method: string, path: string, body: unknown): { action: string; input?: unknown } | null {
  const payload = () => typeof body === "string" ? JSON.parse(body) : (body ?? {});
  if (path === "/computers") {
    if (method === "GET") return { action: "listComputers" };
    if (method === "POST") return { action: "addComputer", input: payload() };
  }
  if (path === "/computers/host-key" && method === "POST") {
    return { action: "checkComputerHostKey", input: payload() };
  }
  const entry = path.match(/^\/computers\/([0-9a-f-]{36})(\/.*)?$/u);
  if (!entry) return null;
  const [, id, suffix] = entry;
  if (method === "DELETE" && !suffix) return { action: "deleteComputer", input: { id } };
  if (method === "GET" && suffix === "/connection") return { action: "getComputerConnection", input: { id } };
  if (method === "POST") {
    if (suffix === "/reconnect") return { action: "reconnectComputer", input: { id } };
    if (suffix === "/start") return { action: "startComputer", input: { id } };
    if (suffix === "/oauth/start") return { action: "startComputerOauth", input: { id, payload: payload() } };
  }
  if (method === "PATCH" && !suffix) return { action: "updateComputerModel", input: { id, payload: payload() } };
  if (method === "PUT" && !suffix) return { action: "editComputer", input: { id, payload: payload() } };
  const oauth = suffix?.match(/^\/oauth\/([A-Za-z0-9_-]{1,128})(\/cancel)?$/u);
  if (oauth) {
    const [, flow, cancel] = oauth;
    if (method === "GET" && !cancel) return { action: "getComputerOauth", input: { id, flow } };
    if (method === "POST" && cancel) return { action: "cancelComputerOauth", input: { id, flow } };
  }
  return null;
}
