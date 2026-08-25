import type { ProjectWorkOperationIdentity } from "./project-work-contracts.ts";
import type { ProjectWorkWriteContext } from "./project-work-write-context.ts";

export async function requireObservedProjectWorkReceipt(input: {
  context: ProjectWorkWriteContext;
  identity: ProjectWorkOperationIdentity;
  expectedTarget: { id: string; kind: string; parentId: string | null };
}): Promise<void> {
  const outcome = await input.context.publish(input.identity, () =>
    Promise.resolve(null),
  );
  if (
    outcome.skipped ||
    !outcome.targets.some(
      (target) =>
        target.id === input.expectedTarget.id &&
        target.kind === input.expectedTarget.kind &&
        target.parentId === input.expectedTarget.parentId,
    )
  )
    throw new Error("project_work_occurrence_receipt_missing");
}
