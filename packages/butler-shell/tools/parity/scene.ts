import type { NativeAppServerHandle } from "../../../../tests/support/native-app-server.ts";
import { waitBrowser } from "../../../../tests/support/browser-agent-app.ts";

export type Anchor = { anchor: string; electron: string };
export type Box = { anchor: string; x: number; y: number; w: number; h: number };
export type Scene = {
  name: string;
  seed: Array<{ method: string; path: string; body: Record<string, unknown>; wait?: boolean }>;
  open: { chat: string } | { new: true };
  anchors: Anchor[];
};
type View = { latest_turn?: { state: string }; messages: Array<{ id: string }> };

function expand<T>(value: T, variables: Record<string, string>): T {
  return JSON.parse(JSON.stringify(value).replace(/\$\{([^}]+)\}/gu, (_, key: string) => {
    if (!(key in variables)) throw new Error(`Unknown scene variable: ${key}`);
    return JSON.stringify(variables[key]).slice(1, -1);
  })) as T;
}

export async function seed(server: NativeAppServerHandle, scene: Scene) {
  const variables: Record<string, string> = {};
  for (const step of scene.seed) {
    const body = expand(step.body, variables);
    if (step.path === "/messages") body.client_message_id = crypto.randomUUID();
    const result = await server.api<{ session?: { id: string } }>(expand(step.path, variables), {
      method: step.method, body: JSON.stringify(body),
    });
    if (result.session) variables.session = result.session.id;
    if (step.wait) {
      await waitBrowser(async () => {
        const view = await server.api<View>(`/session-view?session_id=${encodeURIComponent(variables.session)}`);
        return view.latest_turn?.state === "delivered";
      }, "seed turn delivered");
    }
  }
  return { chat: variables.session, anchors: async () => {
    if (variables.session) {
      const view = await server.api<View>(`/session-view?session_id=${encodeURIComponent(variables.session)}`);
      view.messages.forEach((message, index) => { variables[`message.${index}`] = message.id; });
    }
    return expand(scene.anchors, variables);
  } };
}
