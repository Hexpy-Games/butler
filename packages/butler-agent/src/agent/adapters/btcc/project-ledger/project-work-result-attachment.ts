import {
  allowedNextWorkStages,
  type AttachToolResultInput,
  type DurableWorkToolResultRef,
} from "../../../btcc/work/index.ts";
import { requestDigest, projectWorkRecordId } from "./project-work-json.ts";
import { projectWorkViewUpdates } from "./project-work-record-updates.ts";
import { requireCurrentProjectWork } from "./project-work-snapshot.ts";
import type { ProjectWorkWriteContext } from "./project-work-write-context.ts";
import { workRevisions } from "./project-work-write-context.ts";

export async function attachProjectWorkToolResult(
  context: ProjectWorkWriteContext,
  command: AttachToolResultInput,
) {
  context.assertScope(command);
  const identity = {
    kind: "mutation_call" as const,
    id: command.mutationCallId,
    mutationCallId: command.mutationCallId,
    requestSha256: requestDigest({ operation: "attach_tool_result", input: command }),
  };
  const evidence = context.input.resultRuntime.readCommittedResult(command);
  if (
    evidence.toolCallId !== command.toolCallId ||
    evidence.originTurnId !== command.turnId ||
    evidence.status !== "completed"
  ) invalid("project_work_result_evidence_mismatch");
  const resultRef = projectWorkRecordId("result", command.toolCallId);

  const outcome = await context.publish(identity, async () => {
    const current = await context.requireBound(command, true);
    if (current.view.status === "abandoned") invalid("project_work_not_open");
    if (current.view.resultRefs.some((item) => item.toolCallId === command.toolCallId))
      invalid("project_work_result_already_attached");
    const attachedAt = await context.recordedAt(identity);
    const result: DurableWorkToolResultRef = {
      resultRef,
      toolCallId: evidence.toolCallId,
      toolName: evidence.toolName,
      status: "completed",
      resultSha256: evidence.resultSha256,
      originTurnId: evidence.originTurnId,
      attachedAt,
    };
    const view = {
      ...current.view,
      status: current.view.status === "completed" ? ("open" as const) : current.view.status,
      latestResultReview: undefined,
      latestCompletionValidation: undefined,
      resultRefs: [...current.view.resultRefs, result],
      updatedAt: attachedAt,
    };
    view.allowedNextStages = allowedNextWorkStages(view.currentStage);
    const material = await context.captureMaterial(current.view, view, identity);
    return projectWorkViewUpdates({
      scope: context.input.scope,
      current,
      view,
      operationIdentity: identity,
      revisions: workRevisions(current.manifest),
      material,
      children: [{
        schema: "butler.btcc-project-work-result-reference.v1",
        workId: current.view.workId,
        sessionId: current.view.sessionId,
        scope: {
          appProjectId: context.input.scope.appProjectId,
          ledgerProjectId: context.input.scope.ledgerProjectId,
        },
        operationIdentity: identity,
        result: { ...result, sequence: current.view.resultRefs.length + 1 },
      }],
    });
  });

  const workId = onlyWorkId(outcome.targets, resultRef);
  const current = await requireCurrentProjectWork({
    butlerData: context.input.butlerData,
    scope: context.input.scope,
    workId,
  });
  const children = current.children.filter(
    (child) =>
      child.schema === "butler.btcc-project-work-result-reference.v1" &&
      child.result.resultRef === resultRef,
  );
  if (children.length !== 1) invalid("project_work_result_reference_invalid");
  const child = children[0]!;
  if (child.schema !== "butler.btcc-project-work-result-reference.v1")
    invalid("project_work_result_reference_invalid");
  if (
    child.operationIdentity.id !== identity.id ||
    child.operationIdentity.requestSha256 !== identity.requestSha256 ||
    child.result.toolCallId !== evidence.toolCallId ||
    child.result.toolName !== evidence.toolName ||
    child.result.resultSha256 !== evidence.resultSha256 ||
    child.result.originTurnId !== command.turnId ||
    child.sessionId !== command.sessionId ||
    child.scope.appProjectId !== context.input.scope.appProjectId ||
    child.scope.ledgerProjectId !== context.input.scope.ledgerProjectId
  ) invalid("project_work_result_reference_invalid");
  context.input.resultRuntime.observeCanonicalResult({
    work: current.view,
    scope: context.input.scope,
    result: child.result,
    operationIdentity: identity,
  });
  return current.view;
}

function onlyWorkId(
  targets: Array<{ id: string; kind: string; parentId: string | null }>,
  resultRef: string,
): string {
  const result = targets.filter(
    (target) => target.kind === "reference" && target.id === resultRef,
  );
  if (result.length !== 1 || !result[0]!.parentId)
    return invalid("project_work_result_reference_invalid");
  return result[0]!.parentId!;
}

function invalid(message: string): never {
  throw new Error(message);
}
