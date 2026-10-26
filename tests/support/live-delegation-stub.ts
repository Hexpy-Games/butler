import type { NativeAppServerOptions, StubModelRequest } from "./native-app-server.ts";

export function liveDelegationStub(): { options: NativeAppServerOptions; whenHeld: () => Promise<void>; advance: () => void; release: () => void } {
  let parent = 0;
  let child = 0;
  let resume: (() => void) | undefined;
  let released = false;
  let held = false;
  let onHeld: (() => void) | undefined;
  const steps = new WeakMap<StubModelRequest, { child: boolean; step: number }>();
  const objective = "Delegate a three step progress check.";
  const plan = (mode: string) => ({ start_new: false, objective, execution_mode: mode, governing_refs: [],
    actions: ["first", "second", "third"].map(action_key => ({ action_key, description: `${action_key} check`, dependency_keys: [] })), checks: ["All checks recorded"] });
  const review = { subject: "plan", verdict: "accept", summary: "Ready", corrections: [], action_updates: [] };
  const checkpoint = (step: number) => ({ public_summary: `Progress checkpoint ${step}`, action_updates: [
    { action_key: step === 2 ? "first" : "second", status: "done" },
    { action_key: step === 2 ? "second" : "third", status: "active" },
  ] });
  return {
    whenHeld: () => held ? Promise.resolve() : new Promise<void>(done => { onHeld = done; }),
    advance: () => { held = false; resume?.(); resume = undefined; },
    release: () => { released = true; resume?.(); },
    options: {
      config: { user: { name: "Smoke", language: "en" } },
      stubReply: async request => {
        const users = request.messages.filter(message =>
          typeof message === "object" && message !== null && (message as { role?: string }).role === "user").map(message => JSON.stringify(message));
        const input = users.at(-1) ?? "";
        // The steward's scope opens its Turn; later continuation prompts in that Turn do not repeat it.
        const isChild = users.some(message => message.includes("role: steward"));
        // Background rounds (title, smart group) stream the same text but offer no tools; only turns do.
        const turn = Array.isArray(request.body.tools) && request.body.tools.length > 0;
        if (!request.stream || !turn || (!isChild && !input.includes(objective))) return "{}";
        const step = isChild ? child++ : parent++;
        steps.set(request, { child: isChild, step });
        if (isChild && step >= 2 && !released) await new Promise<void>(done => {
          resume = done; held = true; onHeld?.(); onHeld = undefined;
        });
        return isChild ? "" : step >= 1 ? "Delegated work started." : "";
      },
      stubToolCall: request => {
        const current = steps.get(request);
        if (!current) return null;
        const { child, step } = current;
        if (!child) return [
          { name: "delegate_to_steward", arguments: { request: objective, checks: ["All checks recorded"], safe_title: "Live progress check" } },
        ][step] ?? null;
        if (step === 0) return { name: "replace_work_plan", arguments: plan("direct") };
        if (step === 1) return { name: "record_work_review", arguments: review };
        if (step <= 3) return { name: "record_work_checkpoint", arguments: checkpoint(step) };
        return null;
      },
    },
  };
}
