import type { NativeAppServerOptions, StubModelRequest } from "./native-app-server.ts";

export const stepTitles = ["collect sources", "compare options", "write summary", "check availability"];
export const stepObjective = "Delegate a comparison and summary with an accepted plan.";
export const firstStepActivity = "Collected source notes";

function workId(messages: unknown[]): string | undefined {
  for (const message of [...messages].reverse()) {
    const content = (message as { content?: unknown }).content;
    if (typeof content !== "string") continue;
    try {
      const parsed = JSON.parse(content) as { output?: { work?: { work_id?: string } } };
      const id = parsed.output?.work?.work_id;
      if (id) return id;
    } catch { /* Non-tool messages are plain text. */ }
  }
  return undefined;
}

function childCalls(path: string) {
  const plan = (count: number) => ({ objective: stepObjective, execution_mode: "direct", governing_refs: [],
    actions: stepTitles.slice(0, count).map(title => ({ action_key: title,
      description: title, dependency_keys: [] })), checks: ["Summary saved"] });
  const review = { subject: "plan", verdict: "accept", summary: "Ready", corrections: [], action_updates: [] };
  const checkpoint = (summary: string, statuses: string[], current: number) => ({ public_summary: summary,
    current_action_key: stepTitles[current - 1], action_updates: statuses.map((status, index) => ({ action_key: stepTitles[index], status })) });
  return [
    { name: "replace_work_plan", arguments: plan(3) },
    { name: "record_work_review", arguments: review },
    { name: "record_work_checkpoint", arguments: checkpoint(firstStepActivity, ["active", "pending", "pending"], 1) },
    { name: "read_file", arguments: { requests: [{ path }] } },
    { name: "record_work_checkpoint", arguments: checkpoint("Comparing the collected options", ["done", "active", "pending"], 2) },
    { name: "replace_work_plan", arguments: plan(4) },
    { name: "record_work_review", arguments: review },
    { name: "record_work_checkpoint", arguments: checkpoint("Checking current availability", ["done", "active", "pending", "active"], 4) },
    { name: "read_file", arguments: { requests: [{ path }] } },
    { name: "record_work_checkpoint", arguments: checkpoint("Writing the comparison summary", ["done", "done", "active", "done"], 3) },
    { name: "record_work_checkpoint", arguments: checkpoint("All steps checked", ["done", "done", "done", "done"], 3) },
    { name: "write_file", arguments: { path: `${path}.summary`, content: "Comparison complete", create_parents: true } },
  ];
}

export function workCardStepsStub(path: string) {
  let parent = 0, child = 0, released = false, held = false;
  let resume: (() => void) | undefined;
  let onHeld: (() => void) | undefined;
  const steps = new WeakMap<StubModelRequest, { child: boolean; step: number }>();
  const calls = childCalls(path);
  const options: NativeAppServerOptions = {
    config: { user: { name: "Smoke", language: "ko" } },
    stubReply: async request => {
      const users = request.messages.filter(message => (message as { role?: string }).role === "user").map(message => JSON.stringify(message));
      const isChild = users.some(message => message.includes("role: steward"));
      if (!request.stream || !Array.isArray(request.body.tools) || request.body.tools.length === 0 ||
          (!isChild && !users.some(message => message.includes(stepObjective)))) return "{}";
      const step = isChild ? child++ : parent++;
      steps.set(request, { child: isChild, step });
      if (isChild && step === 9 && !released) await new Promise<void>(done => {
        resume = done; held = true; onHeld?.(); onHeld = undefined;
      });
      return isChild ? step > calls.length ? "Comparison complete." : "" : step ? "비교를 진행하고 있습니다." : "";
    },
    stubToolCall: request => {
      const current = steps.get(request);
      if (!current) return null;
      if (!current.child) return current.step === 0 ? { name: "delegate_to_steward", arguments: {
        request: stepObjective, checks: ["Summary saved"], safe_title: "Comparison progress",
      } } : null;
      if (current.step === calls.length) return { name: "record_work_disposition", arguments: {
        work_id: workId(request.messages), disposition: "completed", summary: "Comparison complete",
        action_updates: [], remaining_actions: [], followups: [],
      } };
      return calls[current.step] ?? null;
    },
  };
  return { options, whenHeld: () => held ? Promise.resolve() : new Promise<void>(done => { onHeld = done; }),
    advance: () => { released = true; held = false; resume?.(); }, release: () => { released = true; resume?.(); } };
}
