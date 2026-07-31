import type {
  DurableWorkPlanAction,
  LegacyWorkRecordSnapshot,
  WorkStage,
} from "../../../btcc/durable-work/index.ts";

const MAX_IMPORTED_ACTIONS = 20;
const MAX_IMPORTED_CHECKS = 16;

export type LegacyWorkProjection = {
  objective: string;
  originalMessageId?: string;
  plan?: {
    actions: DurableWorkPlanAction[];
    checks: string[];
  };
  checkpoint?: {
    stage: WorkStage;
    publicSummary: string;
    nextStep: string;
  };
};

export function projectLegacyOpenWork(input: {
  goal: unknown;
  plan: unknown;
  works: LegacyWorkRecordSnapshot[];
  tasks: LegacyWorkRecordSnapshot[];
  readRecord(recordId: string): unknown;
}): LegacyWorkProjection {
  const goal = record(input.goal);
  const plan = record(input.plan);
  const objective = firstText([
    goal?.request,
    goal?.intendedResult,
    input.works.map((item) => record(item.content)?.outcome),
    plan?.strategy,
  ], 800) ?? "Continue the unfinished Butler work.";
  const originalMessageId = conciseText(goal?.originalMessageId, 200);
  const sources = input.tasks.length > 0 ? input.tasks : input.works;
  const actions = projectActions(sources, input.tasks.length > 0);
  const checks = projectChecks(input, goal);
  return {
    objective,
    ...(originalMessageId ? { originalMessageId } : {}),
    ...(actions.length > 0 ? { plan: { actions, checks } } : {}),
    ...(input.tasks.length > 0
      ? {
          checkpoint: progressCheckpoint(input.tasks, actions),
        }
      : {}),
  };
}

function projectActions(
  sources: LegacyWorkRecordSnapshot[],
  tasks: boolean,
): DurableWorkPlanAction[] {
  const selected = sources.slice(0, MAX_IMPORTED_ACTIONS);
  const keys = uniqueActionKeys(selected, tasks);
  const refToKey = new Map<string, string>();
  selected.forEach((item, index) => {
    refToKey.set(item.recordId, keys[index]!);
    const content = record(item.content);
    const ownRef = referenceId(content?.ref);
    if (ownRef) refToKey.set(ownRef, keys[index]!);
  });
  return selected.map((item, index) => {
    const content = record(item.content);
    const title = conciseText(
      tasks ? content?.displayTitle : content?.workLogicalId,
      160,
    );
    const outcome = conciseText(
      tasks ? content?.intendedOutcome : content?.outcome,
      400,
    );
    const description = [title, outcome]
      .filter((value, partIndex, values): value is string =>
        Boolean(value) && values.indexOf(value) === partIndex)
      .join(": ") || `Continue imported action ${index + 1}.`;
    const dependencyField = tasks
      ? content?.dependencyTaskRefs
      : content?.dependencyWorkRefs;
    return {
      actionKey: keys[index]!,
      description,
      dependencyKeys: referenceIds(dependencyField)
        .map((ref) => refToKey.get(ref))
        .filter((key): key is string => Boolean(key)),
    };
  });
}

function uniqueActionKeys(
  sources: LegacyWorkRecordSnapshot[],
  tasks: boolean,
): string[] {
  const used = new Set<string>();
  return sources.map((item, index) => {
    const content = record(item.content);
    const base = conciseText(
      tasks ? content?.taskLogicalId : content?.workLogicalId,
      80,
    ) ?? `legacy-action-${index + 1}`;
    let key = base;
    let suffix = 2;
    while (used.has(key)) key = `${base}-${suffix++}`.slice(0, 96);
    used.add(key);
    return key;
  });
}

function projectChecks(
  input: {
    goal: unknown;
    plan: unknown;
    tasks: LegacyWorkRecordSnapshot[];
    readRecord(recordId: string): unknown;
  },
  goal: Record<string, unknown> | null,
): string[] {
  const checks: string[] = [];
  for (const task of input.tasks) {
    const content = record(task.content);
    for (const ref of referenceIds(content?.criterionRefs)) {
      const statement = conciseText(record(input.readRecord(ref))?.statement, 300);
      if (statement && !checks.includes(statement)) checks.push(statement);
      if (checks.length >= MAX_IMPORTED_CHECKS) return checks;
    }
  }
  const acceptance = conciseText(goal?.acceptanceIntent, 300);
  if (acceptance && !checks.includes(acceptance)) checks.push(acceptance);
  return checks.slice(0, MAX_IMPORTED_CHECKS);
}

function progressCheckpoint(
  tasks: LegacyWorkRecordSnapshot[],
  actions: DurableWorkPlanAction[],
): LegacyWorkProjection["checkpoint"] {
  const accepted = tasks.filter((task) => task.status === "accepted").length;
  const currentIndex = tasks.findIndex((task) => task.status !== "accepted");
  const nextStep = currentIndex >= 0
    ? actions[currentIndex]?.description
    : "Review the imported work against the current request.";
  return {
    stage: "execution",
    publicSummary:
      `Imported prior progress: ${accepted} of ${tasks.length} planned actions ` +
      "have recorded accepted results.",
    nextStep: nextStep ?? "Review the imported work against the current request.",
  };
}

function firstText(values: unknown[], limit: number): string | null {
  for (const value of values.flat()) {
    const text = conciseText(value, limit);
    if (text) return text;
  }
  return null;
}

function conciseText(value: unknown, limit: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/gu, " ").trim();
  return text ? text.slice(0, limit) : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function referenceIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(referenceId).filter((id): id is string => Boolean(id));
}

function referenceId(value: unknown): string | null {
  return conciseText(record(value)?.id, 300);
}
