/** Tool bridge calls go through the real guided executor, without provider calls. */
import { strict as assert } from "node:assert";
import type { StubModelRequest } from "./native-app-server";
type Call = { name: string; arguments: Record<string, unknown> };
type Step = (request: StubModelRequest) => Call | null;
export function browserStub() {
  let steps: Step[] = [], index = 0;
  const results: unknown[] = [];
  const handler = (request: StubModelRequest) => {
    if (!request.stream) return null;
    results.push(request.messages.filter(message => (message as { role?: string }).role === "tool"));
    try { return steps[index++]?.(request) ?? null; }
    catch (error) { results.push({ stubFailure: String(error) }); return null; }
  };
  return { handler, results, set: (next: Step[]) => { steps = next; index = 0; } };
}
export const describeBrowser = () => ({ name: "tool_describe", arguments: { ids: ["browser_open", "browser_observe", "browser_act", "browser_tabs", "browser_close", "browser_wait_for_user"].map(name=>`native:${name}`) } });
export const bridgeBrowser = (name: string, arguments_: Record<string, unknown>): Call => ({ name: "tool_call", arguments: { id: `native:${name}`, arguments: arguments_ } });
export function latestBrowser(request: StubModelRequest, field: "tab" | "obs") {
  function find(value: unknown): Record<string, unknown> | undefined {
    if (typeof value === "string") { try { return find(JSON.parse(value)); } catch { return undefined; } }
    if (!value || typeof value !== "object") return undefined;
    const record = value as Record<string, unknown>;
    if (typeof record[field] === "string" && record.status === "ok") return record;
    for (const item of Object.values(record)) { const found = find(item); if (found) return found; }
  }
  for (const message of [...request.messages].reverse()) {
    if ((message as { role?: string }).role !== "tool") continue;
    const found = find(message); if (found) return found;
  }
  assert.fail(`No browser ${field} result: ${JSON.stringify(request.messages.filter(message=>(message as { role?: string }).role === "tool"))}`);
}
export function actConfirm(request: StubModelRequest) {
  const observation = latestBrowser(request, "obs");
  const text = (observation.untrusted_content as { text: string }).text;
  const ref = /button "Confirm" \[([^\]]+)\]/u.exec(text)?.[1]; assert.ok(ref, text);
  return bridgeBrowser("browser_act", { tab: observation.tab, observation: observation.obs, steps: [{ action: "click", ref }] });
}
