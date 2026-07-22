import {
  contentRef,
  requireRecord,
  requireString,
  requireStringArray,
  type ContentRef,
} from "../../core/index.ts";
import type {
  ManagedPlanningAssumption,
  ManagedPlanningRisk,
  ManagedTask,
} from "../contracts.ts";

export function authorPlanningConsiderations(
  submission: Record<string, unknown>,
  tasks: ManagedTask[],
  programId: string,
): {
  risks: ManagedPlanningRisk[];
  assumptions: ManagedPlanningAssumption[];
} {
  const risks = requireArray(submission.risks, "risks").map((value, index) => {
    const draft = requireRecord(value, `risks[${index}]`);
    const body = {
      logicalId: requireString(draft.logicalId, "risk.logicalId"),
      programId,
      statement: requireString(draft.statement, "risk.statement"),
      affectedTaskRefs: taskRefs(draft.affectedTaskIds, tasks, "risk"),
      mitigation: requireString(draft.mitigation, "risk.mitigation"),
      ...(draft.residualRisk === undefined
        ? {}
        : { residualRisk: requireString(draft.residualRisk, "risk.residualRisk") }),
    };
    return { ref: contentRef("planning-risk", body), ...body };
  });
  const assumptions = requireArray(submission.assumptions, "assumptions")
    .map((value, index) => {
      const draft = requireRecord(value, `assumptions[${index}]`);
      const body = {
        logicalId: requireString(draft.logicalId, "assumption.logicalId"),
        programId,
        statement: requireString(draft.statement, "assumption.statement"),
        affectedTaskRefs: taskRefs(draft.affectedTaskIds, tasks, "assumption"),
        validationQuestion: requireString(
          draft.validationQuestion,
          "assumption.validationQuestion",
        ),
        invalidationConsequence: requireString(
          draft.invalidationConsequence,
          "assumption.invalidationConsequence",
        ),
      };
      return { ref: contentRef("planning-assumption", body), ...body };
    });
  assertUnique(risks.map((risk) => risk.logicalId), "Risk logical id");
  assertUnique(assumptions.map((assumption) => assumption.logicalId), "Assumption logical id");
  return { risks, assumptions };
}

function taskRefs(value: unknown, tasks: ManagedTask[], label: string): ContentRef[] {
  const ids = requireStringArray(value, `${label}.affectedTaskIds`);
  if (ids.length === 0) throw new Error(`${label} requires affected Tasks`);
  assertUnique(ids, `${label} affected Task`);
  const byId = new Map(tasks.map((task) => [task.taskLogicalId, task.ref]));
  return ids.map((id) => {
    const ref = byId.get(id);
    if (!ref) throw new Error(`${label} names an unknown Task: ${id}`);
    return ref;
  });
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function assertUnique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} is not unique`);
}
