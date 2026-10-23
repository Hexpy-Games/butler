import { useState } from "react";
import type { CanonOverview } from "@/app/canonApi.ts";
import { defaultCanonPlan } from "./canonPlanSelection.ts";
const key = (projectId: string) => `butler:canon-plan:${projectId}`;
function read(projectId: string): string | null | undefined {
  try {
    const raw = localStorage.getItem(key(projectId));
    if (raw === null) return undefined;
    const value: unknown = JSON.parse(raw);
    return value === null || typeof value === "string" ? value : undefined;
  } catch { return undefined; }
}
export function useCanonPlanSelection(projectId: string, canon: CanonOverview | null) {
  const [choice, setChoice] = useState<{ projectId: string; id: string | null }>();
  const stored = choice?.projectId === projectId ? choice.id : read(projectId);
  const id = stored === null || canon?.plans.some(plan => plan.id === stored) ? stored : canon ? defaultCanonPlan(canon.plans) : null;
  const select = (id: string | null) => {
    setChoice({ projectId, id });
    try { localStorage.setItem(key(projectId), JSON.stringify(id)); } catch { /* Selection still works without storage. */ }
  };
  return { id: id ?? null, select };
}
