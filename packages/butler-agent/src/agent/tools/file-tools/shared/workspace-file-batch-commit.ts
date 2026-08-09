import {
  commitWorkspaceFileMutation,
  type CommittedWorkspaceFileMutation,
  type PreparedWorkspaceFileMutation,
  type WorkspaceMutationError,
  type WorkspaceMutationFailure,
} from "./workspace-file-mutation.ts";

export interface WorkspaceBatchCommitApplied {
  index: number;
  result: CommittedWorkspaceFileMutation;
}

export interface WorkspaceBatchCommitConflict {
  index: number;
  result: WorkspaceMutationFailure;
}

export type WorkspaceBatchCommitResult =
  | { ok: true; applied: WorkspaceBatchCommitApplied[] }
  | {
      ok: false;
      error: "external_change_conflict" | "partial_apply" | Exclude<WorkspaceMutationError, "external_change_conflict">;
      applied: WorkspaceBatchCommitApplied[];
      conflicting: WorkspaceBatchCommitConflict[];
      not_attempted: Array<{ index: number; path: string }>;
    };

/** Commit prepared files in request order without rollback or replay. */
export async function commitWorkspaceFileMutationBatch(
  prepared: readonly PreparedWorkspaceFileMutation[],
): Promise<WorkspaceBatchCommitResult> {
  const applied: WorkspaceBatchCommitApplied[] = [];
  for (const [index, item] of prepared.entries()) {
    const result = await commitWorkspaceFileMutation(item);
    if (!result.ok) {
      const error = applied.length === 0
        ? result.error
        : "partial_apply" as const;
      return {
        ok: false,
        error,
        applied,
        conflicting: [{ index, result }],
        not_attempted: prepared.slice(index + 1).map((entry, offset) => ({ index: index + 1 + offset, path: entry.path })),
      };
    }
    applied.push({ index, result });
  }
  return { ok: true, applied };
}
