// Offline gateway stream/HTTP fixture shared by usage smoke and Electron captures.
import { createServer, type ServerResponse } from "node:http";
import { firstRunStub } from "./first-run-stub";
import type { NativeAppServerHandle } from "./native-app-server";
import { chatGptUsageFixtures, usageView } from "../../packages/butler-app/client/ui/src/components/conversation/contextUsage.fixtures";
import type { TimelineEvent, ModelCatalogView, ProviderAuthMethod } from "../../packages/butler-app/client/ui/src/app/types";

/** Copies the output shape of runtime_event.rs + runtime_progress.rs + append_progress.
 * The nested note is emitted by butler-turn/btcc/model_route/projection.rs::fallback.
 * Both projections identify the same source event; the progress row uses snake_case.
 */
export function fallbackEvents(id: string, auth: ProviderAuthMethod = "chatgpt_oauth", code = "provider_quota_exhausted"): TimelineEvent[] {
  const created = "2026-10-23T05:00:00Z", turn = "fallback-turn", session = "butler-client";
  const note = "대체 모델 경로로 계속 진행합니다.";
  return [
    { type: "agent.turn_event", payload: { session_id: session, turn_id: turn, event: {
      id, sessionId: session, turnId: turn, sessionSequence: 1, turnSequence: 1, createdAt: created,
      kind: "assistant.public_note", visibility: "public", payload: {
        note, failureCode: code, authType: auth, btccState: "executing", decisionTitle: "대체 모델 경로 선택",
        decisionSummary: note, decisionSource: "model-authored", semanticBlockId: `${turn}:model-fallback:round:1`,
        originTurnId: turn, sourceRevision: 1, model: "openai/gpt-6-luna",
      },
    } } },
    { type: "agent.turn_event.progress", payload: { session_id: session, turn_id: turn, event_id: id, row: {
      id, kind: "message", state: "running", safe_label: note, created_at: created, turn_event_sequence: 1,
      work_block_label: "대체 모델 경로 선택", failure_code: code, auth_type: auth,
    } } },
  ];
}

export async function chatGptPlanFixture(gateway: NativeAppServerHandle) {
  const stub = await firstRunStub(gateway);
  const streams = new Set<ServerResponse>();
  const state = { holdAccount: false, quota: chatGptUsageFixtures.limit, registered: false, visualControls: false };
  const catalog = await gateway.api<ModelCatalogView>("/model-catalog");
  const plan = { ...catalog.models.find(model => model.model_ref === "openai/gpt-6-luna")!,
    auth_type: "chatgpt_oauth", availability: "ready", registered: true, enabled: true };
  const server = createServer((req, res) => { void (async () => {
    const path = new URL(req.url!, "http://localhost").pathname;
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "authorization,content-type");
    res.setHeader("access-control-allow-methods", "GET,POST,PATCH,DELETE,OPTIONS");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
    if (path === "/events/live") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(": connected\n\n"); streams.add(res); res.on("close", () => streams.delete(res)); return;
    }
    if (path === "/setup/chatgpt-account") while (state.holdAccount && !res.destroyed) await new Promise(done => setTimeout(done, 20));
    const controlSession = state.visualControls && req.method === "GET" ? /^\/sessions\/([^/]+)\/controls$/u.exec(path)?.[1] : undefined;
    const data = controlSession ? { session_id: decodeURIComponent(controlSession), revision: 0, catalog_generation: "harness-model-catalog-v1",
      controls: { model: "openai/gpt-6-luna", reasoning_effort: "none", access_mode: "full_access", plan_mode: false } }
      : path === "/provider-quota" ? state.quota : path === "/usage-monitor" ? usageView({ quota: state.quota })
      : path === "/model-catalog" && state.registered ? { ...catalog, registered_models: [plan] } : undefined;
    if (data) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ protocol_version: "butler.app.v1", data })); return; }
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const upstream = await fetch(new URL(req.url!, stub.url), { method: req.method, headers: { ...gateway.authHeaders, "content-type": "application/json" },
      ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) });
    res.writeHead(upstream.status, Object.fromEntries([...upstream.headers].filter(([name]) => !["content-encoding", "transfer-encoding", "content-length"].includes(name))));
    res.end(Buffer.from(await upstream.arrayBuffer()));
  })().catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); }); });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  let sequence = 0;
  return { state, account: stub.state, url: `http://127.0.0.1:${port}`, get connections() { return streams.size; },
    emit(events: TimelineEvent[]) { for (const event of events) for (const stream of streams) stream.write(`data: ${JSON.stringify({ ...event, id: ++sequence })}\n\n`); },
    stop() { state.holdAccount = false; for (const stream of streams) stream.end(); server.closeAllConnections(); server.close(); stub.stop(); },
  };
}
