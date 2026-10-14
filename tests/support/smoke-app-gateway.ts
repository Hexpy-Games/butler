/** Offline gateway for native App shell lifecycle checks; no model calls. */
import { createServer } from "node:http";
import { once } from "node:events";
import { HARNESS_MODEL_CATALOG } from "../../packages/butler-app/client/ui/src/app/fixtures";
import { EMPTY_SETTINGS, EMPTY_NAVIGATION } from "../../packages/butler-app/client/ui/src/app/constants";

export async function smokeAppGateway() {
  const server = createServer((request, response) => {
    response.setHeader("access-control-allow-origin", "*");
    response.setHeader("access-control-allow-headers", "authorization,content-type");
    if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return; }
    const path = new URL(request.url!, "http://127.0.0.1").pathname;
    const data = path === "/health" ? { ok: true }
      : path === "/runtime-readiness" ? { authenticated_gateway_ready: true, btcc_executor_ready: true }
        : path === "/settings" ? { ...EMPTY_SETTINGS, onboarding: { completed_at: null, accepted_at: null, consent_version: null } }
          : path === "/model-catalog" ? HARNESS_MODEL_CATALOG : EMPTY_NAVIGATION;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ protocol_version: "butler.app.v1", data }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  let stopping: Promise<void> | undefined;
  return { port, url: `http://127.0.0.1:${port}`, stop() {
    return stopping ??= new Promise<void>((done, fail) => {
      server.close(error => error ? fail(error) : done()); server.closeAllConnections();
    });
  } };
}
