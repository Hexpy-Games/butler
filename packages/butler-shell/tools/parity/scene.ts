import type { NativeAppServerHandle } from "../../../../tests/support/native-app-server.ts";
import { waitBrowser } from "../../../../tests/support/browser-agent-app.ts";

/** `scroll` names the gpui anchor of the scroll port the anchor sits in: before a click the native
 * side centres the anchor in it, as Electron's click does (`scrollIntoView({block: "center"})`). */
export type Anchor = { anchor: string; electron: string; scroll?: string };
export type Box = { anchor: string; x: number; y: number; w: number; h: number };
export type Scene = {
  name: string;
  pendingReply?: string;
  /** Stub model reply for every streamed turn; defaults to the shared meeting-notes answer. */
  reply?: string;
  /** Tool calls the stub model makes, one per streamed round with tools, in order, before it replies. */
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
  seed: Array<{ method: string; path: string; body: Record<string, unknown>; wait?: boolean; save?: Record<string, string> }>;
  /** `setup`: the first run is not complete, so the window opens on the setup (both sides wait for it). */
  open: { chat: string } | { new: true } | { setup: true };
  /** Sent before every capture on both sides, so a state a step saves (the consent, a memory choice)
   * is back to the seed's when the next capture starts. */
  reset?: Array<{ method: string; path: string; body: Record<string, unknown> }>;
  anchors: Anchor[];
  /** What must exist in `/session-view` before capture. */
  ready?: "authority_requests" | "pending_questions" | "artifacts";
  /** Before each screenshot, in order: click an anchor, rest the pointer on it (reveals hover-only
   * controls), or wait for it to exist. */
  steps?: Array<{ click: string } | { hover: string } | { expect: string }>;
};
type View = { latest_turn?: { state: string }; messages: Array<{ id: string }> };

function expand<T>(value: T, variables: Record<string, unknown>): T {
  if (typeof value === "string") {
    const exact = /^\$\{([^}]+)\}$/u.exec(value);
    if (exact) {
      if (!(exact[1] in variables)) throw new Error(`Unknown scene variable: ${exact[1]}`);
      return variables[exact[1]] as T;
    }
    return value.replace(/\$\{([^}]+)\}/gu, (_, key: string) => {
      if (!(key in variables)) throw new Error(`Unknown scene variable: ${key}`);
      return String(variables[key]);
    }) as T;
  }
  if (Array.isArray(value)) return value.map(item => expand(item, variables)) as T;
  if (value && typeof value === "object") return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, expand(item, variables)]),
  ) as T;
  return value;
}

export async function seed(server: NativeAppServerHandle, scene: Scene) {
  const variables: Record<string, unknown> = {};
  for (const step of scene.seed) {
    const body = expand(step.body, variables);
    if (step.path === "/messages") body.client_message_id = crypto.randomUUID();
    const result = await server.api<{ session?: { id: string }; [key: string]: unknown }>(expand(step.path, variables), {
      method: step.method, ...(step.method === "GET" ? {} : { body: JSON.stringify(body) }),
    });
    if (result.session) variables.session = result.session.id;
    for (const [key, path] of Object.entries(step.save ?? {})) {
      let value: unknown = result;
      for (const part of path.split(".")) {
        if (!value || typeof value !== "object") throw new Error(`Missing scene capture: ${path}`);
        value = (value as Record<string, unknown>)[part];
      }
      if (value === undefined) throw new Error(`Missing scene capture: ${path}`);
      variables[key] = value;
    }
    if (step.wait) {
      await waitBrowser(async () => {
        const view = await server.api<View>(`/session-view?session_id=${encodeURIComponent(String(variables.session))}`);
        return view.latest_turn?.state === "delivered";
      }, "seed turn delivered");
    }
  }
  return { chat: typeof variables.session === "string" ? variables.session : undefined, anchors: async () => {
    if (variables.session) {
      const view = await server.api<View>(`/session-view?session_id=${encodeURIComponent(String(variables.session))}`);
      view.messages.forEach((message, index) => { variables[`message.${index}`] = message.id; });
    }
    return expand(scene.anchors, variables);
  }, steps: () => expand(scene.steps, variables) };
}
