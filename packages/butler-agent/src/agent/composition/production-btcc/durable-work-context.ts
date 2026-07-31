import type { DurableWorkContext } from "../../btcc/durable-work/index.ts";

export function renderDurableWorkContext(
  context: DurableWorkContext | null,
): string | null {
  if (!context) return null;
  const { work } = context;
  const plan = work.currentPlan;
  const rows = [
    `Original request: ${singleLine(context.originalRequest.content, 1_200)}`,
    `Status: ${work.status}`,
    `Objective: ${singleLine(work.objective, 800)}`,
  ];
  if (plan) {
    rows.push("Current plan:");
    for (const action of plan.actions.slice(0, 12)) {
      const dependencies = action.dependencyKeys.length > 0
        ? ` (after: ${action.dependencyKeys.join(", ")})`
        : "";
      const effect = action.effect
        ? ` [effect: ${singleLine(action.effect.capability, 80)} -> ${singleLine(action.effect.target, 160)}]`
        : "";
      rows.push(
        `- ${singleLine(action.actionKey, 80)}: ${singleLine(action.description, 400)}` +
          `${dependencies}${effect}`,
      );
    }
    if (plan.checks.length > 0) {
      rows.push(`Checks: ${plan.checks.slice(0, 8).map((item) => singleLine(item, 240)).join("; ")}`);
    }
  }
  if (work.latestCheckpoint) {
    rows.push(
      `Latest progress (${work.latestCheckpoint.stage}): ` +
        `${singleLine(work.latestCheckpoint.publicSummary, 600)}`,
      `Next step: ${singleLine(work.latestCheckpoint.nextStep, 400)}`,
    );
  }
  if (work.latestPlanReview) {
    const current = work.currentPlan?.planRevisionId ===
      work.latestPlanReview.boundPlanRevisionId;
    rows.push(
      `Latest plan review${current ? "" : " (outdated)"}: ` +
        `${work.latestPlanReview.verdict} — ` +
        singleLine(work.latestPlanReview.summary, 500),
    );
    pushCorrections(rows, "Plan corrections", work.latestPlanReview.corrections);
  }
  if (work.latestResultReview) {
    const bound = new Set(work.latestResultReview.boundResultRefs);
    const current = bound.size === work.resultRefs.length &&
      work.resultRefs.every((result) => bound.has(result.resultRef));
    rows.push(
      `Latest result review${current ? "" : " (outdated)"}: ` +
        `${work.latestResultReview.verdict} — ` +
        singleLine(work.latestResultReview.summary, 500),
    );
    pushCorrections(rows, "Result corrections", work.latestResultReview.corrections);
  }
  for (const fact of context.resultFacts.slice(-8)) {
    rows.push(
      `Result (${singleLine(fact.toolName, 100)}, ${fact.status}): ` +
        singleLine(resultFactText(fact), 1_000),
    );
  }
  return rows.join("\n").slice(0, 8_000);
}

function pushCorrections(rows: string[], label: string, corrections: string[]): void {
  if (corrections.length === 0) return;
  rows.push(
    `${label}: ${corrections.slice(0, 6).map((item) => singleLine(item, 240)).join("; ")}`,
  );
}

function singleLine(value: string, limit: number): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, limit);
}

function resultFactText(fact: {
  resultJson?: unknown;
  errorCode?: string;
}): string {
  if (fact.resultJson !== undefined) {
    if (typeof fact.resultJson === "string") return fact.resultJson;
    try {
      return JSON.stringify(fact.resultJson) ?? "No result body recorded.";
    } catch {
      return "Result body is unavailable.";
    }
  }
  return fact.errorCode ?? "No result body recorded.";
}
