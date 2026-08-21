import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import {
  resolveSessionWorkspaceAuthority,
  validateSessionWorkspaceAuthority,
} from "../../session-workspaces/index.ts";
import { createPlatformCommandExecutor } from "../../../runtime/command/platform-command-executor.ts";
import { workspaceFileEditBatchTargetForPaths } from "../agent-loop/guided-workspace-file-edit-batch.ts";
import type { GuidedToolJournalRecord } from "../ports/guided-tool-journal.ts";
import type { CompletionEvidenceInput } from "./completion-evidence.ts";
import {
  factualCompletionFailure,
  retryableCompletionFailure,
} from "./completion-evidence-errors.ts";

type AppliedMutationEvidence = {
  capability: string;
  sanitizedTarget: string;
  receipt: { result: unknown };
  mutationTool: GuidedToolJournalRecord;
};

type MutationArtifactEvidence = {
  path: string;
  afterSha256?: string;
  createdFromAbsent: boolean;
};

export async function validateMutationArtifactSet(
  input: CompletionEvidenceInput,
  mutations: readonly AppliedMutationEvidence[],
  requiredFinalTargets: ReadonlySet<string>,
): Promise<string[]> {
  const child = input.sessionBindings.getBySessionId(
    input.relation.child_session_id,
  );
  const parent = input.sessionBindings.getBySessionId(
    input.relation.parent_session_id,
  );
  if (!child || !parent)
    retryableCompletionFailure("subsession_workspace_binding_unavailable");
  if (child.workspacePath === parent.workspacePath) {
    factualCompletionFailure("subsession_isolated_workspace_missing");
  }
  const authority = resolveSessionWorkspaceAuthority({ binding: child });
  const workspace = input.packet.workspace_and_worktree;
  if (
    input.packet.execution_mode !== "mutation" ||
    workspace.ownership !== "session" ||
    authority.kind !== "session_worktree" ||
    authority.branch !== workspace.branch
  ) {
    factualCompletionFailure("subsession_child_worktree_identity_invalid");
  }
  const validated = await validateSessionWorkspaceAuthority({
    authority,
    commandExecutor: createPlatformCommandExecutor(),
  });
  if (!validated.ok)
    retryableCompletionFailure(
      "subsession_child_worktree_validation_unavailable",
    );
  if (
    validated.path !== child.workspacePath ||
    validated.path === parent.workspacePath
  ) {
    factualCompletionFailure("subsession_child_worktree_identity_invalid");
  }
  const artifacts = mutations.flatMap((mutation) => {
    const receiptResult = record(mutation.receipt.result);
    return mutation.capability === "edit_file" &&
        mutation.sanitizedTarget.startsWith("workspace:batch:")
      ? batchArtifactEvidence(
          mutation.mutationTool.arguments,
          mutation.mutationTool.result,
          receiptResult,
          mutation.sanitizedTarget,
        )
      : singleArtifactEvidence(
          mutation.sanitizedTarget,
          receiptResult,
          record(mutation.mutationTool.result),
        );
  });
  if (artifacts.length === 0) {
    factualCompletionFailure("subsession_mutation_file_evidence_missing");
  }
  const finalArtifacts = new Map<string, MutationArtifactEvidence>();
  for (const artifact of artifacts) {
    const target = safeRelativeMutationTarget(artifact.path);
    if (
      !target ||
      !mutationTargetWithinScope(target, input.packet.mutation_scope)
    ) {
      factualCompletionFailure("subsession_mutation_target_out_of_scope");
    }
    const latest = finalArtifacts.get(target);
    if (!latest) {
      finalArtifacts.set(target, { ...artifact, path: target });
    } else {
      latest.createdFromAbsent = artifact.createdFromAbsent;
    }
  }
  for (const [target, artifact] of finalArtifacts) {
    const absoluteTarget = join(validated.path, target);
    if (
      isAbsolute(target) ||
      relative(validated.path, absoluteTarget).startsWith("..")
    ) {
      factualCompletionFailure("subsession_mutation_target_invalid");
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(absoluteTarget);
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        if (artifact.createdFromAbsent && !requiredFinalTargets.has(target)) {
          finalArtifacts.delete(target);
          continue;
        }
        factualCompletionFailure("subsession_mutation_file_evidence_missing");
      }
      throw error;
    }
    if (
      artifact.afterSha256 &&
      createHash("sha256").update(bytes).digest("hex") !== artifact.afterSha256
    ) {
      factualCompletionFailure("subsession_mutation_file_receipt_mismatch");
    }
  }
  return [...finalArtifacts.keys()].sort();
}

export function mutationTargetWithinScope(
  target: string,
  scopes: readonly string[],
): boolean {
  const normalizedTarget = safeRelativeMutationTarget(target);
  return Boolean(
    normalizedTarget &&
    scopes.some((scope) => {
      const normalizedScope = safeRelativeMutationTarget(scope);
      return (
        normalizedScope &&
        (normalizedTarget === normalizedScope ||
          (normalizedScope.endsWith("/") &&
            normalizedTarget.startsWith(normalizedScope)))
      );
    }),
  );
}

export function safeRelativeMutationTarget(value: string): string | null {
  const normalized = value.trim().replaceAll("\\", "/").replace(/^\.\//u, "");
  return !normalized ||
    normalized.startsWith("/") ||
    normalized.split("/").includes("..")
    ? null
    : normalized;
}

function batchArtifactEvidence(
  toolArgumentsValue: unknown,
  toolResultValue: unknown,
  receiptResult: Record<string, unknown> | null,
  sanitizedTarget: string,
): MutationArtifactEvidence[] {
  const toolArguments = record(toolArgumentsValue);
  const toolResult = record(toolResultValue);
  const argumentEntries = Array.isArray(toolArguments?.edits)
    ? toolArguments.edits
    : [];
  const toolEntries = Array.isArray(toolResult?.applied)
    ? toolResult.applied
    : [];
  const receiptEntries = Array.isArray(receiptResult?.entries)
    ? receiptResult.entries
    : [];
  if (
    toolResult?.effect !== "workspace_file_edit_batch" ||
    receiptResult?.effect !== "workspace_file_edit_batch" ||
    argumentEntries.length < 2 ||
    argumentEntries.length !== receiptEntries.length ||
    (toolEntries.length > 0 && toolEntries.length !== argumentEntries.length)
  ) {
    factualCompletionFailure("subsession_mutation_batch_evidence_mismatch");
  }
  const paths = argumentEntries.map((value) => record(value)?.path);
  if (
    paths.some((path) => typeof path !== "string") ||
    workspaceFileEditBatchTargetForPaths(paths as string[]) !== sanitizedTarget
  ) {
    factualCompletionFailure("subsession_mutation_batch_evidence_mismatch");
  }
  return argumentEntries.map((value, index) => {
    const argumentEntry = record(value);
    const toolEntry =
      toolEntries.length > 0 ? record(toolEntries[index]) : null;
    const receiptEntry = record(receiptEntries[index]);
    const path = argumentEntry?.path;
    if (
      !receiptEntry ||
      receiptEntry.index !== index ||
      typeof path !== "string" ||
      typeof receiptEntry.after_sha256 !== "string" ||
      (toolEntry !== null &&
        (toolEntry.index !== index ||
          toolEntry.path !== path ||
          toolEntry.after_sha256 !== receiptEntry.after_sha256))
    ) {
      factualCompletionFailure("subsession_mutation_batch_evidence_mismatch");
    }
    return {
      path,
      afterSha256: receiptEntry.after_sha256,
      createdFromAbsent: false,
    };
  });
}

function singleArtifactEvidence(
  sanitizedTarget: string,
  receiptResult: Record<string, unknown> | null,
  toolResult: Record<string, unknown> | null,
): MutationArtifactEvidence[] {
  const target = safeRelativeMutationTarget(
    sanitizedTarget.replace(/^workspace:/u, ""),
  );
  if (!target) factualCompletionFailure("subsession_mutation_target_invalid");
  if (
    receiptResult &&
    typeof receiptResult.path === "string" &&
    !mutationTargetWithinScope(receiptResult.path, [target])
  ) {
    factualCompletionFailure("subsession_receipt_target_mismatch");
  }
  return [
    {
      path: target,
      ...(typeof receiptResult?.after_sha256 === "string"
        ? { afterSha256: receiptResult.after_sha256 }
        : {}),
      createdFromAbsent:
        toolResult?.created_from_absent === true ||
        receiptResult?.created_from_absent === true,
    },
  ];
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
