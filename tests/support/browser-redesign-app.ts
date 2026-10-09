import { strict as assert } from "node:assert";
import { join } from "node:path";
import { browserAgentApp, waitBrowser } from "./browser-agent-app";
import { browserStub } from "./browser-agent-stub";
import { shellReady } from "./browser-shell-acceptance";

export async function redesignApp(evidence: string) {
  const stub = browserStub();
  const app = await browserAgentApp(evidence, stub.handler);
  const send = async (text: string) => {
    const prior = await app.gateway.api<{ latest_turn?: { id: string } }>("/session-view?session_id=general");
    await app.gateway.api("/messages", { method: "POST", body: JSON.stringify({ chat_id: "general", text, client_message_id: crypto.randomUUID() }) });
    await waitBrowser(async () => (await app.gateway.api<{ latest_turn?: { id: string } }>("/session-view?session_id=general")).latest_turn?.id !== prior.latest_turn?.id, "new scripted turn admitted");
  };
  const delivered = () => waitBrowser(async () => (await app.gateway.api<{ latest_turn?: { state: string } }>("/session-view?session_id=general")).latest_turn?.state === "delivered", "scripted turn delivered");
  await app.gateway.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "en", appearance_theme: "light", access_mode: "full_access" }) });
  stub.set([
    () => ({ name: "write_file", arguments: { path: "redesign/index.html", create_parents: true,
      content: '<!doctype html><meta charset="utf-8"><title>Browser fixture</title><style>body{margin:0;padding:36px;background:white;color:#172033;font:18px system-ui}button{background:#365bf5;color:white;padding:12px 24px;border:0;border-radius:8px}input{font:inherit;padding:12px}</style><h1>Browser fixture</h1><p>Complete page content</p><button id="confirm" onclick="document.getElementById(\'result\').textContent=\'Confirmed\'">Confirm</button><input aria-label="Note"><p id="result">Ready</p>' } }),
    () => ({ name: "output_publish", arguments: { path: "redesign", title: "Browser fixture" } }),
  ]);
  await send("Publish browser fixture"); await delivered();
  const artifacts = await app.gateway.api<{ artifacts: Array<{ id: string; kind: string }> }>("/artifacts?session_id=general");
  const output = artifacts.artifacts.find((item) => item.kind === "web"); assert.ok(output);
  const view = await app.gateway.api<{ url: string }>(`/outputs/${output.id}/view`);
  const admin = JSON.parse(await Bun.file(join(app.gateway.butlerData, "app/runtime/auth/local-admin.json")).text()).secret as string;
  const internal = async (op: string, tab?: string, args = {}, session = "general") => {
    const response = await fetch(`${app.gateway.url}/internal/browser/calls`, { method: "POST", headers: { ...app.gateway.authHeaders, "x-butler-admin": admin, "content-type": "application/json" }, body: JSON.stringify({ op, session, tab, args }) });
    assert.equal(response.status, 200); return response.json() as Promise<any>;
  };
  const settings = async (language: string, theme: string, width: number) => {
    await app.gateway.api("/settings", { method: "PATCH", body: JSON.stringify({ language, appearance_theme: theme }) });
    await app.main(`${app.win}.setContentSize(${width},900)`);
    await app.page.reload(); await shellReady(app, language);
  };
  return { ...app, stub, send, delivered, url: view.url, internal, settings };
}
