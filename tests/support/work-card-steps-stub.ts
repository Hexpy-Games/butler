import type { NativeAppServerOptions, StubModelRequest } from "./native-app-server.ts";

export const stepTitles = ["collect sources", "compare options", "write summary", "check availability"];
export const stepObjective = "Delegate a comparison and summary with an accepted plan.";
export const firstStepActivity = "Collected source notes";
export const workerObjective = "Research two topics in parallel with workers.";
export const workerStepTitles = ["research domestic", "research overseas"];
export const workerCardTitle = "Parallel research";

type WorkerRole = "parent" | "steward" | "worker";

function workerRole(users: string[]): WorkerRole {
  if (users.some(message => message.includes("role: worker"))) return "worker";
  return users.some(message => message.includes("role: steward")) ? "steward" : "parent";
}

function workerCall(role: WorkerRole, step: number, messages: unknown[], path: string) {
  const stepActions = (status: string) => workerStepTitles.map(t => ({ action_key: t, status }));
  const review = (action_updates: unknown[]) => ({ subject: "plan", verdict: "accept", summary: "Ready",
    corrections: [], action_updates });
  if (role === "parent") return step === 0 ? { name: "delegate_to_steward", arguments: {
    request: workerObjective, checks: ["Findings saved"], safe_title: workerCardTitle } } : null;
  if (role === "steward") {
    if (step === 0) return { name: "replace_work_plan", arguments: { subjects: [{ key: "topics", label: "Topics" }],
      objective: workerObjective, execution_mode: "workers", governing_refs: [],
      actions: workerStepTitles.map(t => ({ action_key: t, description: t, dependency_keys: [] })), checks: ["Findings saved"] } };
    if (step === 1) return { name: "record_work_review", arguments: review(stepActions("active")) };
    if (step === 2 || step === 3) {
      const t = workerStepTitles[step - 2]!;
      return { name: "delegate_to_worker", arguments: { action_key: t, objective: `Research ${t}`,
        acceptance_criteria: ["Findings saved"], implementation_brief: `Research ${t}`, safe_title: `Research ${t}`,
        task: { scope: { owns: [{ subject: "topics", aspects: [t] }], paths: [`tasks/${t.replace(/ /g, "-")}`] },
          output: { format: "text", fields: ["summary"] } } } };
    }
    if (step === 4) return { name: "wait_for_worker", arguments: {} };
    return step === 5 ? { name: "record_work_disposition", arguments: { work_id: workId(messages),
      disposition: "completed", summary: "Findings saved", action_updates: stepActions("done"),
      remaining_actions: [], followups: [] } } : null;
  }
  if (step === 0) return { name: "replace_work_plan", arguments: { subjects: [{ key: "topic", label: "Topic" }],
    objective: "Research the topic", execution_mode: "direct", governing_refs: [],
    actions: [{ action_key: "read notes", description: "read notes", dependency_keys: [] }], checks: ["Findings saved"] } };
  if (step === 1) return { name: "record_work_review", arguments: review([]) };
  if (step === 2) return { name: "read_file", arguments: { requests: [{ path }] } };
  return step === 3 ? { name: "record_work_disposition", arguments: { work_id: workId(messages),
    disposition: "completed", summary: "Notes read", action_updates: [{ action_key: "read notes", status: "done" }],
    remaining_actions: [], followups: [] } } : null;
}

const workerCallCount: Record<WorkerRole, number> = { parent: 1, steward: 6, worker: 4 };
const workerFinalReply: Record<WorkerRole, string> = { parent: "조사를 진행하고 있습니다.", steward: "Findings saved.", worker: "Notes read." };

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
  let workersHeld = 0;
  let resumeWorkers: (() => void) | undefined;
  let onWorkersHeld: (() => void) | undefined;
  const workerHold = new Promise<void>(done => { resumeWorkers = done; });
  const workerSteps = new WeakMap<StubModelRequest, { role: WorkerRole; step: number }>();
  let onHeld: (() => void) | undefined;
  const steps = new WeakMap<StubModelRequest, { child: boolean; step: number }>();
  const calls = childCalls(path);
  const options: NativeAppServerOptions = {
    config: { user: { name: "Smoke", language: "ko" } },
    stubReply: async request => {
      const users = request.messages.filter(message => (message as { role?: string }).role === "user").map(message => JSON.stringify(message));
      if (users.some(message => message.includes(workerObjective) || message.includes("role: worker"))) {
        if (!request.stream || !Array.isArray(request.body.tools) || request.body.tools.length === 0) return "{}";
        const role = workerRole(users);
        // The parent chat also holds the first scenario's history; count from this request on.
        const since = role === "parent" ? request.messages.findLastIndex(message =>
          (message as { role?: string }).role === "user" && JSON.stringify(message).includes(workerObjective)) : 0;
        const step = request.messages.slice(since).filter(message => (message as { role?: string }).role === "tool").length;
        workerSteps.set(request, { role, step });
        if (role === "worker" && step === 3) {
          workersHeld += 1;
          if (workersHeld >= 2) { onWorkersHeld?.(); onWorkersHeld = undefined; }
          await workerHold;
        }
        return step >= workerCallCount[role] ? workerFinalReply[role] : "";
      }
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
      const scenario = workerSteps.get(request);
      if (scenario) return workerCall(scenario.role, scenario.step, request.messages, path);
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
    advance: () => { released = true; held = false; resume?.(); },
    whenWorkersHeld: () => workersHeld >= 2 ? Promise.resolve() : new Promise<void>(done => { onWorkersHeld = done; }),
    release: () => { released = true; resume?.(); resumeWorkers?.(); } };
}
