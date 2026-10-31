// A real gateway with an API-key model on a local stub, and usage rows seeded on disk.
import { appendFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createNativeAppServer, type NativeAppServerHandle } from "./native-app-server";

export const USAGE_MODEL = "openai/gpt-6-luna";
export const SPLIT_CHAT = "Login form refactor";
export const SOLO_CHAT = "Daily review";

/** `[scope, role, prompt, cached, output, hours ago]`; a role of `main` is the chat itself. */
type SeedRow = [scope: string, role: string, prompt: number, cached: number, output: number, hoursAgo: number];

/**
 * The split chat's two subtasks and its own calls. Per type in the latest bar: new 40k with
 * 18k from subtasks, cached 34k with 12k, output 15k with 6k; the earlier bar is its own work.
 * The whole chat is 100k tokens: 64k its own, 36k from subtasks in 2 calls.
 */
const SPLIT_ROWS = (root: string): SeedRow[] => [
  [root, "main", 10_000, 5_000, 1_000, 2],
  [root, "main", 44_000, 22_000, 9_000, 0],
  ["usage-subtask-a", "worker", 19_000, 10_000, 3_000, 0],
  ["usage-subtask-b", "steward", 11_000, 2_000, 3_000, 0],
];
const SOLO_ROWS = (root: string): SeedRow[] => [[root, "main", 30_000, 12_000, 3_000, 0]];

/** The seeded total and subtask tokens per type of the split chat's latest bar. */
export const SPLIT_BAR = { total: 89_000, subtask: { new: 18_000, cache: 12_000, output: 6_000 } as Record<string, number> };

function responseBody(id: string) {
  return { id: `resp_${id}`, object: "response", status: "completed", model: "gpt-6-luna",
    output: [{ type: "message", id: `msg_${id}`, role: "assistant", status: "completed",
      content: [{ type: "output_text", text: "Done.", annotations: [] }] }],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } };
}

/** A local OpenAI Responses endpoint that counts what reaches it. */
function startResponsesStub() {
  let requests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (new URL(request.url).pathname.endsWith("/responses")) requests += 1;
    const body = await request.json().catch(() => ({})) as { stream?: boolean };
    const response = responseBody(crypto.randomUUID());
    return body.stream
      ? new Response(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`, { headers: { "content-type": "text/event-stream" } })
      : Response.json(response);
  } });
  return { port: server.port, requests: () => requests, stop: () => server.stop(true) };
}

/**
 * The gateway's proxy: a loopback port that refuses every connection and keeps its first
 * line, so a call meant for the internet fails here and names its destination.
 */
export function startEgressTrap() {
  const attempts: string[] = [];
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: {
    data(socket, chunk) { attempts.push(chunk.toString().split("\r\n", 1)[0]!); socket.end(); },
  } });
  const url = `http://127.0.0.1:${listener.port}`;
  return { attempts, stop: () => listener.stop(true),
    env: { HTTPS_PROXY: url, HTTP_PROXY: url, NO_PROXY: "127.0.0.1" } };
}

function appendRows(server: NativeAppServerHandle, root: string, rows: SeedRow[]) {
  mkdirSync(join(server.butlerData, "metrics"), { recursive: true });
  const now = Date.now();
  const lines = rows.map(([scope, role, prompt, cached, output, hoursAgo]) => JSON.stringify({
    ts: now - hoursAgo * 3_600_000 - 1000, model: USAGE_MODEL, scope: `btcc-guided:${scope}`,
    promptTokens: prompt, cachedTokens: cached, totalTokens: prompt + output, rootSessionId: root, role }));
  appendFileSync(join(server.butlerData, "metrics/prompt-cache-usage.jsonl"), `${lines.join("\n")}\n`);
}

async function chatWithContext(server: NativeAppServerHandle, title: string): Promise<string> {
  const { session } = await server.api<{ session: { id: string } }>("/sessions", { method: "POST", body: JSON.stringify({ kind: "chat", title }) });
  const accepted = await server.api<{ turn_id?: string; turn?: { id?: string; turn_id?: string } }>("/messages", { method: "POST",
    body: JSON.stringify({ chat_id: session.id, text: "Hello", client_message_id: crypto.randomUUID() }) });
  const turnId = accepted.turn_id ?? accepted.turn?.turn_id ?? accepted.turn?.id;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const { turns } = await server.api<{ turns: { id: string; state: string }[] }>(`/turns?chat_id=${session.id}`);
    const state = turns.find(turn => turn.id === turnId)?.state;
    if (state === "delivered") return session.id;
    if (state === "failed") throw new Error(`The seeded turn of "${title}" failed:\n${server.diagnostics()}`);
    await Bun.sleep(100);
  }
  throw new Error(`The seeded turn of "${title}" did not finish:\n${server.diagnostics()}`);
}

export type UsageSubtaskFixture = {
  server: NativeAppServerHandle; splitChat: string; soloChat: string; seededTurns: number;
  /** Calls that reached the local Responses stub. */
  stubRequests(): number;
  /** First lines of the calls the gateway tried to send through its proxy, to any non-loopback host. */
  egressAttempts: string[];
  stop(): Promise<void>;
};

/** Two chats with context. The stub turn adds a few tokens and calls of its own, far below what the shares show. */
export async function startUsageSubtaskFixture(uiRoot = "packages/butler-app/client/ui/dist"): Promise<UsageSubtaskFixture> {
  const stub = startResponsesStub();
  const trap = startEgressTrap();
  const server = await createNativeAppServer({ uiRoot: resolve(uiRoot),
    config: { system: { defaultModel: USAGE_MODEL } },
    // OPENAI_BASE_URL alone routes every OpenAI call; a registered model's api_base_url does not apply to this provider.
    env: { ...trap.env, OPENAI_BASE_URL: `http://127.0.0.1:${stub.port}/v1`,
      BUTLER_SECRET_STORE: "file", BUTLER_PLATFORM_SYSTEM_SECRETS: "0", BUTLER_PROVIDER_QUOTA_POLLING: "0" } });
  const stop = async () => { await server.stop(); stub.stop(); trap.stop(); };
  try {
    // The path a user takes: a saved key and a registered model, so the catalog says it is API-key billed.
    const { credential } = await server.api<{ credential: { id: string } }>("/credentials", { method: "POST",
      body: JSON.stringify({ provider_id: "openai", api_key: "usage-smoke-placeholder" }) });
    await server.api("/model-catalog/registered-models", { method: "POST", body: JSON.stringify({ provider_id: "openai", model_id: "gpt-6-luna",
      auth_type: "api_key", credential_id: credential.id }) });
    const splitChat = await chatWithContext(server, SPLIT_CHAT);
    const soloChat = await chatWithContext(server, SOLO_CHAT);
    const split = `butler/app-${splitChat}`;
    const solo = `butler/app-${soloChat}`;
    appendRows(server, split, SPLIT_ROWS(split));
    appendRows(server, solo, SOLO_ROWS(solo));
    return { server, splitChat, soloChat, seededTurns: 2, stubRequests: stub.requests, egressAttempts: trap.attempts, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
