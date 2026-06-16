import { AutomationStore, type AutomationSchedule } from "../../../operations/service/automation-store.ts";

type ToolCall = { args: Record<string, unknown> };

export function createAutomationToolHandlers(input: {
  sessionId?: string;
  automationStore: AutomationStore;
}) {
  return {
    "create_automation": async (call: ToolCall) => {
      const prompt = typeof call.args.prompt === "string" ? call.args.prompt : "";
      const sessionId = typeof call.args.session_id === "string" && call.args.session_id.trim()
        ? call.args.session_id.trim()
        : input.sessionId ?? "butler/main";
      return {
        ok: true,
        automation: input.automationStore.create({
          id: typeof call.args.id === "string" && call.args.id.trim() ? call.args.id.trim() : undefined,
          title: typeof call.args.title === "string" ? call.args.title : undefined,
          prompt,
          sessionId,
          schedule: automationSchedule(call.args),
        }),
      };
    },
    "list_automations": async (call: ToolCall) => ({
      ok: true,
      automations: input.automationStore.list({
        includeDeleted: call.args.include_deleted === true,
      }),
    }),
    "delete_automation": async (call: ToolCall) => {
      const id = typeof call.args.id === "string" ? call.args.id.trim() : "";
      if (!id) throw new Error("delete_automation requires id");
      return {
        ok: true,
        automation: input.automationStore.delete(id),
      };
    },
    "run_due_automations": async (call: ToolCall) => {
      const runs = input.automationStore.claimDue(automationNow(call.args.now));
      return {
        ok: true,
        claimed: runs.length,
        runs,
      };
    },
  };
}

function automationSchedule(args: Record<string, unknown>): AutomationSchedule {
  const scheduleType = typeof args.schedule_type === "string" ? args.schedule_type.trim() : "";
  if (scheduleType === "once") {
    if (typeof args.run_at !== "string" || !args.run_at.trim()) {
      throw new Error("create_automation once schedule requires run_at");
    }
    return {
      type: "once",
      run_at: args.run_at.trim(),
    };
  }
  if (scheduleType === "interval") {
    if (typeof args.interval_minutes !== "number") {
      throw new Error("create_automation interval schedule requires interval_minutes");
    }
    return {
      type: "interval",
      interval_minutes: args.interval_minutes,
      start_at: typeof args.start_at === "string" && args.start_at.trim()
        ? args.start_at.trim()
        : undefined,
    };
  }
  throw new Error("create_automation requires schedule_type once or interval");
}

function automationNow(value: unknown): Date {
  if (typeof value !== "string" || !value.trim()) return new Date();
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("run_due_automations now must be a valid ISO date");
  return date;
}
