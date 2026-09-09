import {
  availableWorkReviewSubjects,
  executableWorkActionKeys,
  type DurableWorkContext,
} from "../work/index.ts";
import type { ToolResultExactReadReference } from
  "../../tools/tool-result-serialization.ts";
import { toolResultPayloadForProvider } from
  "../../tools/tool-result-serialization.ts";
import { OPERATION_RESULT_EXACT_READ_MAX_BYTES } from
  "../../tools/monitoring/read_operation_results/index.ts";

export function renderDurableWorkContext(
  context: DurableWorkContext | null,
  options: { includeResultHistory?: boolean } = {},
): string | null {
  if (!context) return null;
  const { work } = context;
  const plan = work.currentPlan;
  const rows = [
    `Status: ${work.status}`,
    `Current stage: ${work.currentStage ?? "not recorded"}`,
    `Plan execution ownership: ${plan?.executionMode ?? "not yet recorded; replace and review the Plan before new owned execution"}`,
    `Allowed next stages: ${work.allowedNextStages.join(", ") || "none"}`,
    `Available review subjects: ${availableWorkReviewSubjects(work).join(", ") || "none"}`,
    `Stable Work objective: ${singleLine(work.objective)}`,
    `Explicit relation Work id (model-only; never report to user): ${work.workId}`,
  ];
  if (plan?.executionMode === "steward") {
    rows.push("Execution next step: delegate_to_steward after Plan Review; Butler manages this Work and synthesizes the returned result, without executing the assigned actions itself.");
  }
  if (work.currentStage) {
    if (work.currentStage === "review") {
      rows.push(
        "Optional stage focus: review the current Plan or actual execution result and " +
          "record material corrections when that quality check is useful.",
      );
    } else if (work.currentStage === "validation") {
      rows.push(
        "Optional stage focus: validate the whole Work against the original request, " +
          "current Plan and checks, terminal actions, actual results, and effect receipts.",
      );
    }
  }
  if (plan) {
    if (plan.objective !== work.objective) {
      rows.push(`Current Plan focus: ${singleLine(plan.objective)}`);
    }
    if ((plan.governingRefs?.length ?? 0) > 0) {
      rows.push(
        `Governing references: ${summarizeList(plan.governingRefs ?? [], 12, 160)}`,
      );
    }
    rows.push(`Action progress: ${summarizeActionProgress(work)}`);
    if (plan.checks.length > 0) {
      rows.push(`Checks: ${summarizeList(plan.checks, 20, 240)}`);
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
  if (work.latestDisposition) {
    rows.push(
      `Latest Work disposition: ${work.latestDisposition.disposition} — ` +
        singleLine(work.latestDisposition.summary, 300),
    );
    if (work.latestDisposition.remainingActions.length > 0) {
      rows.push(
        `Disposition remaining actions: ${summarizeList(
          work.latestDisposition.remainingActions,
          6,
          120,
        )}`,
      );
    }
    if (work.latestDisposition.nextCondition) {
      rows.push(
        `Disposition next condition: ${singleLine(
          work.latestDisposition.nextCondition,
          300,
        )}`,
      );
    }
  }
  rows.push(
    "Guardrail: follow the current Work policy, stay within the original request and " +
      "governing checks, and settle the bound Work with a truthful disposition before reporting.",
  );
  if (plan) {
    const executable = new Set(executableWorkActionKeys(work));
    rows.push(`Executable action keys: ${[...executable].join(", ") || "none"}`);
    rows.push("Current executable plan details:");
    const progressByKey = new Map(
      work.actionProgress.map((item) => [item.actionKey, item]),
    );
    const orderedActions = [...plan.actions].sort((left, right) => {
      const leftDone = isTerminalAction(progressByKey.get(left.actionKey)?.status);
      const rightDone = isTerminalAction(progressByKey.get(right.actionKey)?.status);
      return Number(leftDone) - Number(rightDone);
    });
    for (const action of orderedActions) {
      const progress = work.actionProgress.find((item) =>
        item.actionKey === action.actionKey);
      const status = progress?.status ?? "pending";
      if (isTerminalAction(status) || !executable.has(action.actionKey)) continue;
      const dependencies = action.dependencyKeys.length > 0
        ? ` (after: ${action.dependencyKeys.join(", ")})`
        : "";
      const effect = action.effect
        ? ` [effect: ${singleLine(action.effect.capability, 80)} -> ${singleLine(action.effect.target, 160)}]`
        : "";
      rows.push(
        `- [${status}${executable.has(action.actionKey) ? ", executable" : ""}] ` +
          `${singleLine(action.actionKey, 80)}: ` +
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
  if (options.includeResultHistory !== false) {
    const factsByResultRef = new Map(context.resultFacts.flatMap((fact) =>
      fact.resultRef ? [[fact.resultRef, fact] as const] : [],
    ));
    work.resultRefs.forEach((result) => {
      const fact = factsByResultRef.get(result.resultRef);
      rows.push(renderOperationResultReference(
        work.workId,
        result,
        fact?.resultJson,
      ));
    });
    context.resultFacts.forEach((fact) => {
      const result = fact.resultRef
        ? work.resultRefs.find((candidate) => candidate.resultRef === fact.resultRef)
        : undefined;
      const exactReadReference = result
        ? operationResultExactReadReference(work.workId, result, fact.resultJson)
        : undefined;
      const payload = toolResultPayloadForProvider({
        ok: fact.status === "completed",
        ...(fact.resultJson !== undefined ? { output: fact.resultJson } : {}),
        ...(fact.errorCode ? { error: { code: fact.errorCode } } : {}),
      }, {
        toolName: fact.toolName,
        ...(exactReadReference ? { exactReadReference } : {}),
      });
      rows.push(
        `Result fact (${singleLine(fact.toolName, 100)}, ${fact.status}): ` +
          JSON.stringify(payload),
      );
    });
  } else {
    rows.push("Prior operation requests and results remain available through list_operation_results and read_operation_results; this context contains current Work state, not a duplicate of execution history.");
  }
  rows.push(
    `Original request (highest priority): ${singleLine(context.originalRequest.content)}`,
  );
  return rows.join("\n");
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

function summarizeList(
  values: string[],
  limit = values.length,
  itemLimit?: number,
): string {
  const shown = values.slice(0, limit).map((value) => singleLine(value, itemLimit));
  const remaining = values.length - shown.length;
  return `${shown.join("; ")}${remaining > 0 ? `; (+${remaining} more)` : ""}`;
}

function isTerminalAction(status: string | undefined): boolean {
  return status === "done" || status === "skipped";
}

function singleLine(value: string, limit?: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return limit === undefined ? normalized : normalized.slice(0, limit);
}

function renderOperationResultReference(
  workId: string,
  result: DurableWorkContext["work"]["resultRefs"][number],
  resultJson?: unknown,
): string {
  if (!result.resultSha256) {
    return `Result reference (${result.toolName}, ${result.status}): ` +
      `result_ref=${result.resultRef}; exact read unavailable (sha256 missing)`;
  }
  const reference = operationResultExactReadReference(workId, result, resultJson);
  if (!reference) {
    return `Result reference (${result.toolName}, ${result.status}): ` +
      `result_ref=${result.resultRef}; sha256=${result.resultSha256}; ` +
      "exact read metadata unavailable in this context";
  }
  return `Result reference (${result.toolName}, ${result.status}): ` +
    JSON.stringify(reference);
}

function operationResultExactReadReference(
  workId: string,
  result: DurableWorkContext["work"]["resultRefs"][number],
  resultJson?: unknown,
): ToolResultExactReadReference | undefined {
  if (!result.resultSha256 || result.revision === undefined ||
      resultJson === undefined) return undefined;
  const serialized = JSON.stringify(resultJson);
  const totalBytes = Buffer.byteLength(serialized, "utf8");
  const arguments_: ToolResultExactReadReference["arguments"] = {
    result_ref: result.resultRef,
    sha256: result.resultSha256,
    revision: result.revision,
    work_id: workId,
    offset: 0,
    length: Math.min(
      OPERATION_RESULT_EXACT_READ_MAX_BYTES,
      Math.max(1, totalBytes),
    ),
  };
  return {
    capability: "read_operation_results",
    arguments: arguments_,
    total_bytes: totalBytes,
  };
}
