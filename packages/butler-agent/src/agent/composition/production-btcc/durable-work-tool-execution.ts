import type {
  DurableWorkPlanAction,
  DurableWorkService,
  DurableWorkView,
  WorkStage,
  WorkTurnScope,
} from "../../btcc/durable-work/index.ts";
import type { DurableWorkToolName } from "./durable-work-tool-definitions.ts";

type WorkToolInput = {
  service: DurableWorkService;
  scope: WorkTurnScope;
  mutationCallId: string;
  name: DurableWorkToolName;
  args: Record<string, unknown>;
};

export async function executeDurableWorkTool(
  input: WorkToolInput,
): Promise<Record<string, unknown>> {
  try {
    const view = input.name === "replace_work_plan"
      ? await input.service.replacePlan(decodePlan(input))
      : input.name === "record_work_checkpoint"
        ? await input.service.recordCheckpoint(decodeCheckpoint(input))
        : await input.service.recordReview(decodeReview(input));
    return { ok: true, work: workToolView(view) };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "work_update_rejected",
        message: error instanceof Error ? error.message : "Work update was rejected.",
      },
    };
  }
}

function decodePlan(input: WorkToolInput) {
  const actions = arrayValue(input.args.actions, "actions").map((value, index) => {
    const action = recordValue(value, `actions[${index}]`);
    const actionKey = stringValue(action.action_key, `actions[${index}].action_key`);
    const effectValue = action.effect;
    const effect = effectValue === undefined
      ? undefined
      : decodeEffect(recordValue(effectValue, `actions[${index}].effect`), index);
    return {
      actionKey,
      description: optionalStringValue(action.description) ?? actionKey,
      dependencyKeys: optionalStringArray(
        action.dependency_keys,
        `actions[${index}].dependency_keys`,
      ),
      ...(effect ? { effect } : {}),
    } satisfies DurableWorkPlanAction;
  });
  return {
    ...input.scope,
    mutationCallId: input.mutationCallId,
    startNew: booleanValue(input.args.start_new, false, "start_new"),
    objective: stringValue(input.args.objective, "objective"),
    actions,
    checks: optionalStringArray(input.args.checks, "checks"),
  };
}

function decodeCheckpoint(input: WorkToolInput) {
  const stage = stringValue(input.args.stage, "stage");
  if (!WORK_STAGE_SET.has(stage)) throw new Error(`Unsupported Work stage: ${stage}`);
  return {
    ...input.scope,
    mutationCallId: input.mutationCallId,
    stage: stage as WorkStage,
    publicSummary: stringValue(input.args.public_summary, "public_summary"),
    nextStep: stringValue(input.args.next_step, "next_step"),
  };
}

function decodeReview(input: WorkToolInput) {
  const subject = stringValue(input.args.subject, "subject");
  const verdict = stringValue(input.args.verdict, "verdict");
  if (subject !== "plan" && subject !== "result") {
    throw new Error(`Unsupported Work review subject: ${subject}`);
  }
  if (verdict !== "accept" && verdict !== "revise" && verdict !== "partial") {
    throw new Error(`Unsupported Work review verdict: ${verdict}`);
  }
  return {
    ...input.scope,
    mutationCallId: input.mutationCallId,
    subject: subject as "plan" | "result",
    verdict: verdict as "accept" | "revise" | "partial",
    summary: stringValue(input.args.summary, "summary"),
    corrections: optionalStringArray(input.args.corrections, "corrections"),
  };
}

function decodeEffect(
  effect: Record<string, unknown>,
  actionIndex: number,
): DurableWorkPlanAction["effect"] {
  return {
    capability: stringValue(effect.capability, `actions[${actionIndex}].effect.capability`),
    target: stringValue(effect.target, `actions[${actionIndex}].effect.target`),
  };
}

function workToolView(work: DurableWorkView): Record<string, unknown> {
  return {
    work_id: work.workId,
    status: work.status,
    objective: work.objective,
    plan_revision: work.currentPlan?.revision ?? null,
    checkpoint_revision: work.latestCheckpoint?.revision ?? null,
    latest_plan_review: work.latestPlanReview?.verdict ?? null,
    latest_result_review: work.latestResultReview?.verdict ?? null,
    result_count: work.resultRefs.length,
  };
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Work update requires ${field}`);
  }
  return value.trim();
}

function optionalStringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function arrayValue(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Work update requires at least one ${field} entry`);
  }
  return value;
}

function optionalStringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`Work update requires ${field} to be an array`);
  return value.map((item, index) => stringValue(item, `${field}[${index}]`));
}

function recordValue(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Work update requires ${field} to be an object`);
  }
  return value as Record<string, unknown>;
}

function booleanValue(value: unknown, fallback: boolean, field: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`Work update requires ${field} to be boolean`);
  return value;
}

const WORK_STAGE_SET = new Set<string>([
  "conception",
  "planning",
  "execution",
  "review",
  "reporting",
]);
