import {
  existsSync,
  readFileSync,
  statSync,
} from "node:fs";
import type {
  ElectronScenarioStep,
  GuidedWorkObservation,
  PreparedRun,
  RendererVisibleActivity,
  StepObservation,
} from "./contracts.ts";
import { resolveFixturePath } from "./scenario-preflight.ts";

function checkWorkExpectation(
  step: ElectronScenarioStep,
  work: GuidedWorkObservation | null,
  prior: ReadonlyMap<string, StepObservation>,
): string[] {
  const expected = step.expect?.work;
  if (!expected) return [];
  const failures: string[] = [];
  if (expected.exists === false) {
    if (work) failures.push(`work_present:${work.workId}`);
    return failures;
  }
  if (!work) return ["work_missing"];
  if (expected.status && work.status !== expected.status) {
    failures.push(`work_status:${work.status}:expected:${expected.status}`);
  }
  if (
    expected.planRevisionAtLeast !== undefined &&
    (work.planRevision ?? 0) < expected.planRevisionAtLeast
  ) {
    failures.push(
      `work_plan_revision:${work.planRevision ?? "none"}:minimum:${expected.planRevisionAtLeast}`,
    );
  }
  if (expected.checkpointStage && work.checkpointStage !== expected.checkpointStage) {
    failures.push(
      `work_checkpoint:${work.checkpointStage ?? "none"}:expected:${expected.checkpointStage}`,
    );
  }
  if (
    expected.checkpointStagesInclude &&
    !containsOrderedStages(work.checkpointStages, expected.checkpointStagesInclude)
  ) {
    failures.push(
      `work_checkpoint_sequence:${work.checkpointStages.join(",")}:expected_subsequence:${expected.checkpointStagesInclude.join(",")}`,
    );
  }
  if (
    expected.planReviewVerdict &&
    work.planReviewVerdict !== expected.planReviewVerdict
  ) {
    failures.push(
      `work_plan_review:${work.planReviewVerdict ?? "none"}:expected:${expected.planReviewVerdict}`,
    );
  }
  if (
    expected.resultReviewVerdict &&
    work.resultReviewVerdict !== expected.resultReviewVerdict
  ) {
    failures.push(
      `work_result_review:${work.resultReviewVerdict ?? "none"}:expected:${expected.resultReviewVerdict}`,
    );
  }
  if (
    expected.completionValidationVerdict &&
    work.completionValidationVerdict !== expected.completionValidationVerdict
  ) {
    failures.push(
      `work_completion_validation:${work.completionValidationVerdict ?? "none"}:expected:${expected.completionValidationVerdict}`,
    );
  }
  for (const toolName of expected.resultToolNamesInclude ?? []) {
    if (!work.resultToolNames.includes(toolName)) {
      failures.push(`work_result_tool_missing:${toolName}`);
    }
  }
  if (
    expected.projectLedgerCloseout !== undefined &&
    work.projectLedgerCloseoutObserved !== expected.projectLedgerCloseout
  ) {
    failures.push(
      `project_ledger_closeout:${work.projectLedgerCloseoutObserved}:expected:${expected.projectLedgerCloseout}`,
    );
  }
  if (expected.sameWorkAsStep) {
    const previousWork = prior.get(expected.sameWorkAsStep)?.work;
    if (!previousWork) {
      failures.push(`work_reference_missing:${expected.sameWorkAsStep}`);
    } else if (previousWork.workId !== work.workId) {
      failures.push(
        `work_id:${work.workId}:expected_step:${expected.sameWorkAsStep}:${previousWork.workId}`,
      );
    }
  }
  return failures;
}

function containsOrderedStages(actual: string[], expected: string[]): boolean {
  let index = 0;
  for (const stage of actual) {
    if (stage === expected[index]) index += 1;
    if (index === expected.length) return true;
  }
  return expected.length === 0;
}

export function checkScenarioExpectations(
  run: PreparedRun,
  step: ElectronScenarioStep,
  terminalState: string,
  finalText: string,
  work: GuidedWorkObservation | null,
  prior: ReadonlyMap<string, StepObservation>,
  rendererActivities: readonly RendererVisibleActivity[] = [],
): { passed: boolean; failures: string[] } {
  const failures: string[] = [];
  const expectedTerminal = step.expect?.terminalState ?? "delivered";
  if (terminalState !== expectedTerminal) {
    failures.push(`terminal:${terminalState}:expected:${expectedTerminal}`);
  }
  for (const expected of step.expect?.finalIncludes ?? []) {
    if (!finalText.includes(expected)) failures.push(`final_missing:${expected}`);
  }
  const expectedRendererStages = step.expect?.rendererActivityStagesInclude;
  if (expectedRendererStages) {
    const actualRendererStages = rendererActivities.map(({ stage }) => stage);
    if (!containsOrderedStages(actualRendererStages, expectedRendererStages)) {
      failures.push(
        `renderer_activity_sequence:${actualRendererStages.join(",")}:expected_subsequence:${expectedRendererStages.join(",")}`,
      );
    }
    if (rendererActivities.some(({ text }) => text.trim().length === 0)) {
      failures.push("renderer_activity_text_missing");
    }
  }
  for (const expected of step.expect?.files ?? []) {
    const filePath = resolveFixturePath(run.workspaceRoot, expected.path);
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      failures.push(`file_missing:${expected.path}`);
      continue;
    }
    const body = readFileSync(filePath, "utf8");
    for (const text of expected.contains ?? []) {
      if (!body.includes(text)) {
        failures.push(`file_text_missing:${expected.path}:${text}`);
      }
    }
  }
  failures.push(...checkWorkExpectation(step, work, prior));
  return { passed: failures.length === 0, failures };
}
