import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { NativeAppServerHandle } from "./native-app-server";
import type { AppModelSummary, ModelCatalogView } from "../../packages/butler-app/client/ui/src/app/types";

/** Only external authentication/discovery is stubbed; settings and completion stay durable in the native gateway. */
export async function firstRunStub(gateway: NativeAppServerHandle) {
  const state = {
    oauthStatus: "pending", label: "yeonwoo@example.com", started: 0, cancelled: 0,
    holdCommit: false, failCommit: false, readiness: "ready", local: false, localCalls: 0,
  };
  const catalog = await gateway.api<ModelCatalogView>("/model-catalog");
  const localModel = catalog.registered_models!.find(model => model.model_ref === "local/stub")!;
  const server = createServer((request, response) => {
    void handle(request, response).catch(() => { if (!response.headersSent) json(response, {}, 500); });
  });
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method === "OPTIONS") {
      response.writeHead(204, { "access-control-allow-origin": "app://butler", "access-control-allow-headers": "authorization,content-type",
        "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS" });
      response.end(); return;
    }
    const path = new URL(request.url!, "http://localhost").pathname;
    if (path === "/setup/oauth/start") {
      state.started++;
      return json(response, { status: "pending", flow_id: `stub-${state.started}`, auth_url: "https://signin.invalid/first-run" });
    }
    if (path.startsWith("/setup/oauth/")) {
      if (path.endsWith("/cancel")) { state.cancelled++; return json(response, { status: "cancelled" }); }
      return json(response, { status: state.oauthStatus, label: state.label });
    }
    if (path === "/setup/readiness" || path === "/setup/readiness/retry") return json(response, {
      status: state.readiness, steps: ["data_folder", "model_config", "agent_runtime"].map((id, index) => ({
        id, status: state.readiness === "ready" || index === 0 ? "done" : state.readiness === "failed" ? "failed" : "running",
      })),
    });
    if (path === "/setup/local-model-servers") {
      state.localCalls++;
      return json(response, { servers: state.local ? [{ id: "ollama", label: "Ollama", server_url: "http://127.0.0.1:11434",
        reachable: true, models: [{ id: "stub", size_bytes: 1024 * 1024 * 1024 }] }] : [] });
    }
    if (path === "/setup/credentials/verify") return json(response, { valid: true, verified: true });
    if (path === "/credentials" && request.method === "POST") return json(response, { credential: { id: "stub-key" }, created: true });
    if (path === "/model-catalog/registered-models" && request.method === "POST") {
      const body = await requestBody(request);
      while (state.holdCommit) await new Promise(done => setTimeout(done, 25));
      if (state.failCommit) return json(response, {}, 500);
      const model = { ...localModel, provider_id: body.provider_id, auth_type: body.auth_type } as AppModelSummary;
      return json(response, { model, catalog: { ...catalog, registered_models: [model] } });
    }
    if (path === "/model-catalog/local-models" && request.method === "POST") return json(response, { model: localModel, catalog });
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (value && !["host", "connection", "content-length"].includes(name)) headers.set(name, Array.isArray(value) ? value.join(",") : value);
    }
    const upstream = await fetch(new URL(request.url!, gateway.url), { method: request.method, headers,
      ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) });
    response.writeHead(upstream.status, Object.fromEntries([...upstream.headers].filter(([name]) => !["content-encoding", "transfer-encoding", "content-length"].includes(name))));
    if (path === "/events/live") {
      const reader = upstream.body!.getReader();
      response.on("close", () => void reader.cancel().catch(() => {}));
      while (!response.destroyed) {
        const { done, value } = await reader.read();
        if (done) break;
        response.write(value);
      }
      response.end(); return;
    }
    response.end(Buffer.from(await upstream.arrayBuffer()));
  }
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Stub address missing");
  return { state, url: `http://127.0.0.1:${address.port}`, stop: () => { server.closeAllConnections(); server.close(); } };
}

function json(response: ServerResponse, data: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "app://butler" });
  response.end(JSON.stringify({ protocol_version: "butler.app.v1", ...(status === 200 ? { data } : { error: { code: "provider_unavailable" } }) }));
}

async function requestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
