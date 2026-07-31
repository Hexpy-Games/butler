import type { ProjectLedgerRecordUpdate } from "../../adapters/index.ts";

export const GUIDED_PROJECT_LEDGER_EFFECT_TOOL_NAMES = [
  "project_ledger_create",
  "project_ledger_update",
  "project_ledger_work_update",
  "project_ledger_work_complete",
  "project_ledger_task_update",
  "project_ledger_task_complete",
  "project_ledger_attempt_succeed",
  "project_ledger_attempt_fail",
] as const;

const GUIDED_PROJECT_LEDGER_EFFECT_TOOLS = new Set<string>(
  GUIDED_PROJECT_LEDGER_EFFECT_TOOL_NAMES,
);

export type GuidedProjectLedgerEffect = {
  target: string;
  normalizedInput: Record<string, unknown>;
  updates: ProjectLedgerRecordUpdate[];
};

export function isGuidedProjectLedgerEffectTool(name: string): boolean {
  return GUIDED_PROJECT_LEDGER_EFFECT_TOOLS.has(name);
}

export function guidedProjectLedgerEffect(
  name: string,
  args: Record<string, unknown>,
): GuidedProjectLedgerEffect {
  if (!isGuidedProjectLedgerEffectTool(name)) {
    throw new Error(`Project Ledger effect adapter is unavailable: ${name}`);
  }
  const update = recordUpdate(name, args);
  const kind = update.kind ?? "record";
  return {
    target: `project-ledger:${kind}:${update.id}`,
    normalizedInput: {
      operation: update.operation ?? "update",
      ...update,
    },
    updates: [update],
  };
}

function recordUpdate(
  name: string,
  args: Record<string, unknown>,
): ProjectLedgerRecordUpdate {
  if (name === "project_ledger_create") {
    const kind = requiredString(args.kind, "kind");
    const fields = commonFields(args);
    return {
      operation: "create",
      id: requiredString(args.id, "id"),
      kind,
      title: requiredString(args.title, "title"),
      ...fields,
      ...(kind === "work" && !fields.spec ? { specExemption: true } : {}),
      ...parentFields(args),
    };
  }
  const id = requiredString(args.id, "id");
  const kind = fixedKind(name) ?? requiredString(args.kind, "kind");
  const fields = commonFields(args);
  return {
    operation: "update",
    id,
    kind,
    ...fields,
    ...(name === "project_ledger_work_complete" && !fields.spec
      ? { specExemption: true }
      : {}),
    ...(name === "project_ledger_work_complete" ||
        name === "project_ledger_task_complete"
      ? { status: "done" }
      : name === "project_ledger_attempt_succeed"
        ? { status: "succeeded" }
        : name === "project_ledger_attempt_fail"
          ? { status: "failed" }
          : {}),
  };
}

function fixedKind(name: string): string | undefined {
  if (name.includes("_work_")) return "work";
  if (name.includes("_task_")) return "task";
  if (name.includes("_attempt_")) return "attempt";
  return undefined;
}

function parentFields(args: Record<string, unknown>): Partial<ProjectLedgerRecordUpdate> {
  const workId = optionalString(args.work_id);
  const taskId = optionalString(args.task_id);
  return workId
    ? { parentId: workId }
    : taskId ? { parentId: taskId } : {};
}

function commonFields(args: Record<string, unknown>): Partial<ProjectLedgerRecordUpdate> {
  return defined({
    title: optionalString(args.title),
    status: optionalString(args.status),
    body: optionalString(args.body),
    spec: optionalString(args.spec),
    acceptance: optionalString(args.acceptance),
    validation: optionalString(args.validation),
    review: optionalString(args.review),
    report: optionalString(args.report),
    implementation: optionalString(args.implementation),
    mitigation: optionalString(args.mitigation),
    reason: optionalString(args.reason),
    codeCommits: optionalString(args.code_commits),
    ledgerCommits: optionalString(args.ledger_commits),
    priority: optionalNumber(args.priority),
    requiresCommitEvidence: optionalBoolean(args.requires_commit_evidence),
    specExemption: optionalBoolean(args.spec_exemption),
  });
}

function defined<T extends Record<string, unknown>>(input: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

function requiredString(value: unknown, field: string): string {
  const text = optionalString(value);
  if (!text) throw new Error(`Project Ledger effect requires ${field}`);
  return text;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
