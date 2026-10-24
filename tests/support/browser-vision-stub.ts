/** Offline Responses carrier with catalog-admitted vision; never forwards network calls. */
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { NativeAppServerOptions, StubModelRequest } from "./native-app-server";

export async function browserVisionStub(root: string, handler: NonNullable<NativeAppServerOptions["stubToolCall"]>, reply?: NativeAppServerOptions["stubReply"]) {
  const requests: StubModelRequest[] = [];
  const profile = join(root, "chatgpt.json");
  mkdirSync(root, { recursive: true });
  writeFileSync(profile, JSON.stringify({ client_id: "smoke-client", subject: "smoke-account", access_token: "smoke-access", refresh_token: "smoke-refresh",
    expires_at: Date.now() + 3600000, scopes: ["openid", "chatgpt.tokens.use.direct"] }), { mode: 0o600 });
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url?.endsWith("/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ models: [{ slug: "gpt-6-luna", display_name: "Luna", visibility: "list" }] }));
      return;
    }
    if (request.method !== "POST" || !request.url?.endsWith("/responses")) { response.writeHead(404); response.end(); return; }
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
    const input = body.input as Array<Record<string, unknown>>;
    const messages = input.map(item => item.type === "function_call_output"
      ? { role: "tool", content: item.output, tool_call_id: item.call_id }
      : item.type === "function_call" ? { role: "assistant", tool_calls: [item] } : item);
    const call = { stream: body.stream === true, messages, body }; requests.push(call);
    const tool = Array.isArray(body.tools) && body.tools.length ? handler(call) : null;
    const id = `stub-${requests.length}`;
    let text: string;
    try { text = reply ? await reply(call) : "Stub reply from the isolated smoke model."; }
    catch {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Injected stub provider failure", type: "server_error" } }));
      return;
    }
    const item = tool ? { type: "function_call", namespace: "butler", id: `fc-${id}`, call_id: `call-${id}`, name: tool.name, arguments: JSON.stringify(tool.arguments), status: "completed" }
      : { type: "message", id: `msg-${id}`, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
    const events = [
      { type: "response.created", response: { id, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item },
      tool ? { type: "response.function_call_arguments.delta", item_id: item.id, output_index: 0, delta: item.arguments }
        : { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: item.content?.[0]?.text },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id, object: "response", model: "gpt-6-luna", status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } },
    ];
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const [index, event] of events.entries()) response.write(`data: ${JSON.stringify({ ...event, sequence_number: index })}\n\n`);
    response.end();
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing stub address");
  const options: NativeAppServerOptions = {
    config: { system: { defaultModel: "openai/gpt-6-luna", butlerModel: "openai/gpt-6-luna", workerModel: "openai/gpt-6-luna", stewardModel: "openai/gpt-6-luna" }, models: { registered: [{ provider_id: "openai", model_id: "gpt-6-luna", auth_type: "chatgpt_oauth" }] } },
    env: { BUTLER_CHATGPT_AUTH_DIR: root, BUTLER_CHATGPT_API_BASE_URL: `http://127.0.0.1:${address.port}`, BUTLER_E2E_TIER: "stub" },
  };
  return { options, requests, stop: async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); } };
}
