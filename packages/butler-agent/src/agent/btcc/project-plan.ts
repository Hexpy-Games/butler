import type { GuidedToolJournalRecord } from "./ports/guided-tool-journal.ts";
import { toolResultSucceeded } from "./agent-loop/guided-tool-progress.ts";

/** The public, identity-bearing projection of a top-level Project Ledger Plan. */
export type ProjectLedgerPlan = {
  kind: "plan";
  id: string;
  title: string;
  status: string;
  body: string;
  path?: string;
};

const PLAN_MUTATION_TOOLS = new Set([
  "project_ledger_create",
  "project_ledger_update",
]);

export function isProjectLedgerPlanMutation(toolName: string): boolean {
  return PLAN_MUTATION_TOOLS.has(toolName);
}

export function projectLedgerPlanFromToolRecords(
  records: readonly GuidedToolJournalRecord[],
  options: { expectedId?: string } = {},
): ProjectLedgerPlan | undefined {
  const record = [...records]
    .reverse()
    .find((candidate) =>
      candidate.status === "completed" &&
      isProjectLedgerPlanMutation(candidate.toolName) &&
      candidate.arguments.kind === "plan" &&
      toolResultSucceeded(candidate.result),
    );
  if (!record) return undefined;

  const args = record.arguments;
  const data = resultData(record.result);
  const id = stringValue(data.id) ?? stringValue(args.id);
  const title = stringValue(data.title) ?? stringValue(args.title);
  const body = stringValue(data.body) ?? stringValue(args.body);
  if (!id || !title || !body) return undefined;
  if (options.expectedId && id !== options.expectedId.trim()) return undefined;
  return {
    kind: "plan",
    id,
    title,
    status: stringValue(data.status) ?? stringValue(args.status) ?? "draft",
    body,
    ...(stringValue(data.path) ? { path: stringValue(data.path) } : {}),
  };
}

export function projectLedgerPlanFromUnknown(
  value: unknown,
): ProjectLedgerPlan | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const plan = value as Partial<ProjectLedgerPlan>;
  if (plan.kind !== "plan") return undefined;
  const id = stringValue(plan.id);
  const title = stringValue(plan.title);
  const status = stringValue(plan.status);
  if (!id || !title || !status || typeof plan.body !== "string" || !plan.body.trim()) {
    return undefined;
  }
  return {
    kind: "plan",
    id,
    title,
    status,
    body: plan.body,
    ...(stringValue(plan.path) ? { path: stringValue(plan.path) } : {}),
  };
}

export function projectLedgerPlanFromRecordResult(
  result: Record<string, unknown>,
  expectedId: string,
): ProjectLedgerPlan | undefined {
  if (result.ok === false || !result.data || typeof result.data !== "object" ||
    Array.isArray(result.data)) return undefined;
  const data = result.data as Record<string, unknown>;
  const id = stringValue(data.id);
  const title = stringValue(data.title);
  const body = stringValue(data.body);
  if (id !== expectedId || !title || !body) return undefined;
  return {
    kind: "plan",
    id,
    title,
    status: stringValue(data.status) ?? "draft",
    body,
    ...(stringValue(data.path) ? { path: stringValue(data.path) } : {}),
  };
}

export function renderAcceptedProjectPlanContext(plan: ProjectLedgerPlan): string {
  return [
    "Accepted Project Ledger Plan:",
    `- id: ${plan.id}`,
    `- title: ${plan.title}`,
    "- status: active",
    "",
    plan.body,
  ].join("\n");
}

function resultData(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const data = (value as Record<string, unknown>).data;
  return data && typeof data === "object" && !Array.isArray(data)
    ? data as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
