import type { StubModelRequest } from "./native-app-server";
import { bridgeBrowser, describeBrowser, latestBrowser } from "./browser-agent-stub";

export const browserDelegationObjective = "Open the browser fixture in delegated work.";
export function browserDelegationStub(url: string) {
  let parent = 0, child = 0;
  const objective = browserDelegationObjective;
  const plan = { start_new: false, objective, execution_mode: "steward", governing_refs: [],
    actions: [{ action_key: "browse", description: "Read browser fixture", dependency_keys: [] }], checks: ["Fixture read"] };
  return (request: StubModelRequest) => {
    if (!request.stream) return null;
    const user = JSON.stringify([...request.messages].reverse().find(message => (message as { role?: string }).role === "user"));
    if (user.includes("role: steward")) {
      switch (child++) {
        case 0: return describeBrowser();
        case 1: return bridgeBrowser("browser_open", { url });
        case 2: return bridgeBrowser("browser_observe", { tab: latestBrowser(request, "tab").tab });
        case 3: return bridgeBrowser("browser_tabs", {});
        default: return null;
      }
    }
    if (!user.includes(objective)) return null;
    return [
      { name: "start_work", arguments: { objective } },
      { name: "replace_work_plan", arguments: plan },
      { name: "record_work_review", arguments: { subject: "plan", verdict: "accept", summary: "Ready", corrections: [], action_updates: [] } },
      { name: "delegate_to_steward", arguments: { request: objective, safe_title: "Browser task" } },
    ][parent++] ?? null;
  };
}
