import type { DurableWorkContext } from "../work/index.ts";
import { structuredToolResultModelPreview } from "../../tools/tool-result-model-preview.ts";

export function renderDurableWorkContext(
  context: DurableWorkContext | null,
): string | null {
  if (!context) return null;
  const { work } = context;
  const plan = work.currentPlan;
  const rows = [
    `Original request (highest priority): ${singleLine(context.originalRequest.content, 900)}`,
    `Status: ${work.status}`,
    `Stable Work objective: ${singleLine(work.objective, 500)}`,
  ];
  if (work.currentStage) {
    rows.push(
      `Current stage: ${work.currentStage}`,
      `Allowed next stages: ${work.allowedNextStages.join(", ") || "none"}`,
    );
    if (work.currentStage === "review") {
      rows.push(
        "Stage focus: review the current Plan or actual execution result and record " +
          "material corrections before moving on.",
      );
    } else if (work.currentStage === "validation") {
      rows.push(
        "Stage focus: validate the whole Work against the original request, current " +
          "Plan and checks, terminal actions, actual results, and effect receipts before reporting.",
      );
    }
  }
  if (plan) {
    if (plan.objective !== work.objective) {
      rows.push(`Current Plan focus: ${singleLine(plan.objective, 400)}`);
    }
    if ((plan.governingRefs?.length ?? 0) > 0) {
      rows.push(
        `Governing references: ${summarizeList(plan.governingRefs ?? [], 6, 100)}`,
      );
    }
    rows.push(`Action progress: ${summarizeActionProgress(work)}`);
    if (plan.checks.length > 0) {
      rows.push(`Checks: ${summarizeList(plan.checks, 8, 110)}`);
    }
  }
  for (const blocker of (work.effectBlockers ?? []).slice(0, 3)) {
    rows.push(
      `Unresolved prior effect (${singleLine(blocker.capability, 60)} -> ` +
        `${singleLine(blocker.target, 100)}): ${singleLine(blocker.detail, 180)} ` +
        "Reconcile this exact target before another effect.",
    );
  }
  if (work.latestPlanReview) {
    const current = work.currentPlan?.planRevisionId ===
      work.latestPlanReview.boundPlanRevisionId;
    rows.push(
      `Latest plan review${current ? "" : " (outdated)"}: ` +
        `${work.latestPlanReview.verdict} — ` +
        singleLine(work.latestPlanReview.summary, 260),
    );
    pushCorrections(rows, "Plan corrections", work.latestPlanReview.corrections);
  }
  if (work.latestResultReview) {
    const current = isDurableWorkResultReviewCurrent(work);
    rows.push(
      `Latest result review${current ? "" : " (outdated)"}: ` +
        `${work.latestResultReview.verdict} — ` +
        singleLine(work.latestResultReview.summary, 260),
    );
    pushCorrections(rows, "Result corrections", work.latestResultReview.corrections);
  }
  if (work.latestCompletionValidation) {
    const current = isDurableWorkCompletionValidationCurrent(work);
    rows.push(
      `Latest completion validation${current ? "" : " (outdated)"}: ` +
        `${work.latestCompletionValidation.verdict} — ` +
        singleLine(work.latestCompletionValidation.summary, 260),
    );
    pushCorrections(
      rows,
      "Completion validation corrections",
      work.latestCompletionValidation.corrections,
    );
  }
  rows.push(
    "Guardrail: choose the next useful unresolved action, stay within the original " +
      "request and governing checks, review the actual result, then validate the " +
      "whole Work before reporting.",
  );
  if (plan) {
    rows.push("Current plan details:");
    const progressByKey = new Map(
      work.actionProgress.map((item) => [item.actionKey, item]),
    );
    const orderedActions = [...plan.actions].sort((left, right) => {
      const leftDone = isTerminalAction(progressByKey.get(left.actionKey)?.status);
      const rightDone = isTerminalAction(progressByKey.get(right.actionKey)?.status);
      return Number(leftDone) - Number(rightDone);
    });
    for (const action of orderedActions.slice(0, 8)) {
      const progress = work.actionProgress.find((item) =>
        item.actionKey === action.actionKey);
      const status = progress?.status ?? "pending";
      const dependencies = action.dependencyKeys.length > 0
        ? ` (after: ${action.dependencyKeys.join(", ")})`
        : "";
      const effect = action.effect
        ? ` [effect: ${singleLine(action.effect.capability, 80)} -> ${singleLine(action.effect.target, 160)}]`
        : "";
      rows.push(
        `- [${status}] ${singleLine(action.actionKey, 80)}: ` +
          `${singleLine(action.description, 280)}${dependencies}${effect}` +
          (progress?.note ? ` — ${singleLine(progress.note, 180)}` : ""),
      );
    }
  }
  if (work.latestCheckpoint) {
    if (work.latestCheckpoint.publicSummary) {
      rows.push(
        `Latest progress (${work.latestCheckpoint.stage}): ` +
          `${singleLine(work.latestCheckpoint.publicSummary, 600)}`,
      );
    }
    if (work.latestCheckpoint.nextStep) {
      rows.push(`Next step: ${singleLine(work.latestCheckpoint.nextStep, 400)}`);
    }
  }
  for (const fact of context.resultFacts.slice(-8)) {
    rows.push(
      `Result (${singleLine(fact.toolName, 100)}, ${fact.status}): ` +
        singleLine(resultFactText(fact), 1_000),
    );
  }
  return rows.join("\n").slice(0, 8_000);
}

export function isDurableWorkResultReviewCurrent(
  work: Pick<DurableWorkContext["work"], "latestResultReview" | "resultRefs">,
): boolean {
  if (!work.latestResultReview) return false;
  return sameResultRefs(work.latestResultReview.boundResultRefs, work.resultRefs);
}

export function isDurableWorkCompletionValidationCurrent(
  work: Pick<
    DurableWorkContext["work"],
    | "currentPlan"
    | "latestCompletionValidation"
    | "latestResultReview"
    | "actionProgress"
    | "resultRefs"
  >,
): boolean {
  const validation = work.latestCompletionValidation;
  const resultReview = work.latestResultReview;
  if (validation?.subject !== "completion" || !resultReview) return false;
  if (validation.boundPlanRevisionId !== work.currentPlan?.planRevisionId) {
    return false;
  }
  if (validation.boundResultReviewRevisionId !== resultReview.reviewRevisionId) {
    return false;
  }
  if (!sameActionProgress(validation.boundActionProgress, work.actionProgress)) {
    return false;
  }
  return sameResultRefs(validation.boundResultRefs, work.resultRefs) &&
    isDurableWorkResultReviewCurrent(work);
}

function sameActionProgress(
  bound: DurableWorkContext["work"]["actionProgress"] | undefined,
  current: DurableWorkContext["work"]["actionProgress"],
): boolean {
  return bound?.length === current.length && bound.every((action, index) => {
    const candidate = current[index];
    return candidate?.actionKey === action.actionKey &&
      candidate.status === action.status && candidate.note === action.note;
  });
}

function sameResultRefs(
  boundResultRefs: string[],
  resultRefs: DurableWorkContext["work"]["resultRefs"],
): boolean {
  const bound = new Set(boundResultRefs);
  return bound.size === resultRefs.length &&
    resultRefs.every((result) => bound.has(result.resultRef));
}

function pushCorrections(rows: string[], label: string, corrections: string[]): void {
  if (corrections.length === 0) return;
  rows.push(
    `${label}: ${summarizeList(corrections, 4, 100)}`,
  );
}

function summarizeActionProgress(work: DurableWorkContext["work"]): string {
  const plan = work.currentPlan;
  if (!plan) return "none";
  const progressByKey = new Map(
    work.actionProgress.map((item) => [item.actionKey, item.status]),
  );
  return summarizeList(
    plan.actions.map((action) =>
      `${singleLine(action.actionKey, 52)}=${progressByKey.get(action.actionKey) ?? "pending"}`),
    24,
    72,
  );
}

function summarizeList(values: string[], limit: number, itemLimit: number): string {
  const shown = values.slice(0, limit).map((value) => singleLine(value, itemLimit));
  const remaining = values.length - shown.length;
  return `${shown.join("; ")}${remaining > 0 ? `; (+${remaining} more)` : ""}`;
}

function isTerminalAction(status: string | undefined): boolean {
  return status === "done" || status === "skipped";
}

function singleLine(value: string, limit: number): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, limit);
}

function resultFactText(fact: {
  toolName: string;
  resultJson?: unknown;
  errorCode?: string;
}): string {
  if (fact.resultJson !== undefined) {
    const preview = structuredToolResultModelPreview({
      toolName: fact.toolName,
      output: fact.resultJson,
    });
    if (preview) {
      try {
        return JSON.stringify(preview) ?? "No result body recorded.";
      } catch {
        return "Result body is unavailable.";
      }
    }
    if (typeof fact.resultJson === "string") return fact.resultJson;
    try {
      return JSON.stringify(fact.resultJson) ?? "No result body recorded.";
    } catch {
      return "Result body is unavailable.";
    }
  }
  return fact.errorCode ?? "No result body recorded.";
}
