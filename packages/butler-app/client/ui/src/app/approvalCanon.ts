/** Exact board item supplied by the authority request. */
export interface ApprovalCanon {
  kind: "epic" | "plan";
  title: string;
  project_id: string;
  project_title: string;
  plan_id?: string;
  plan_title?: string;
  due_on?: string;
  description?: string;
}

export function normalizeApprovalCanon(value: unknown): ApprovalCanon | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const canon = value as Record<string, unknown>;
  if ((canon.kind !== "epic" && canon.kind !== "plan") || typeof canon.title !== "string"
    || typeof canon.project_id !== "string" || typeof canon.project_title !== "string") return undefined;
  return { kind: canon.kind, title: canon.title, project_id: canon.project_id, project_title: canon.project_title,
    ...(typeof canon.plan_id === "string" ? { plan_id: canon.plan_id } : {}),
    ...(typeof canon.plan_title === "string" ? { plan_title: canon.plan_title } : {}),
    ...(typeof canon.description === "string" ? { description: canon.description } : {}),
    ...(typeof canon.due_on === "string" ? { due_on: canon.due_on } : {}) };
}
