import type { SqliteGuidedEffectJournal } from "../../adapters/index.ts";
import type { ButlerExecutionPolicy } from "../contracts.ts";
import type {
  DurableWorkService,
  DurableWorkView,
  WorkTurnScope,
} from "../work/index.ts";
import { acceptedPlanEffectId } from "../effects/index.ts";
import type { ActiveProjectLedgerResolver } from
  "../../../integrations/project-ledger/active-project-ledger-reference.ts";
import { ensureActiveProjectLedger } from
  "../../../integrations/project-ledger/ensure-active-project-ledger.ts";
import {
  GIT_INSTALL_URL,
  GitEvidenceCollectionError,
} from "../../tools/project-ledger/git-commit-evidence.ts";
import type { ButlerToolCall } from "../../tools/butler-tools.ts";
import type { WorkspaceReference, SessionWorkspaceBindingStore } from "../../session-workspaces/index.ts";
import type {
  GuidedPersistentEffectContext,
  GuidedPersistentEffectResolution,
} from "./guided-tool-execution-boundary.ts";
import {
  createGuidedProjectLedgerEffectAdapter,
  isGuidedProjectLedgerEffectTool,
} from "./guided-project-ledger-effect.ts";
import { prepareGuidedCommandEffect } from "./guided-command-effect.ts";
import { prepareGuidedMcpToolEffect } from "./guided-mcp-tool-effect.ts";
import {
  createGuidedWorkspaceFileEffectAdapter,
  workspaceFileEffectTarget,
} from "./guided-workspace-file-effect.ts";
import { prepareGuidedWorkspaceFileEdit } from
  "./guided-workspace-file-edit-effect.ts";
import {
  createGuidedSessionWorkspaceEffectAdapter,
  normalizeSessionWorkspaceEffectInput,
} from "./guided-session-workspace-effect.ts";
import type { RuntimeMemoryAttributionPort } from
  "../../../operations/diagnostics/runtime-memory-attribution/index.ts";

type ExecuteRegisteredTool = (prepared?: {
  args: ButlerToolCall["args"];
  rawArguments?: ButlerToolCall["rawArguments"];
}) => Promise<unknown>;

export function createGuidedPersistentEffectResolver(input: {
  butlerHome: string;
  butlerData: string;
  workspacePath: string;
  workspaceReference?: WorkspaceReference;
  sessionId?: string;
  sessionBindingStore?: SessionWorkspaceBindingStore;
  projectId?: string;
  trackingMode: ButlerExecutionPolicy["trackingMode"];
  projectLedgerResolver: ActiveProjectLedgerResolver;
  effectJournal: Pick<SqliteGuidedEffectJournal, "find">;
  originalRequest: string;
  memoryAttribution?: RuntimeMemoryAttributionPort;
}): (
  call: ButlerToolCall,
  executeRegistered: ExecuteRegisteredTool,
  effectContext: GuidedPersistentEffectContext,
) => Promise<GuidedPersistentEffectResolution | null> {
  const activeWorkspacePath = (): string => {
    if (input.workspaceReference) return input.workspaceReference.get();
    if (input.sessionId && input.sessionBindingStore) {
      throw new Error("session_workspace_unavailable");
    }
    return input.workspacePath;
  };
  return async (call, executeRegistered, effectContext) => {
    if (call.name === "bind_session_git_worktree") {
      if (!input.sessionId || !input.sessionBindingStore || !input.workspaceReference) {
        return {
          error: {
            code: "session_workspace_unavailable",
            message: "The guided runtime has no durable session workspace binding.",
            recoverable: true,
          },
        };
      }
      const normalizedInput = normalizeSessionWorkspaceEffectInput(call.args);
      const target = `session-worktree/${normalizedInput.action}/${normalizedInput.branch}`;
      return {
        target,
        input: normalizedInput,
        adapter: createGuidedSessionWorkspaceEffectAdapter({
          butlerData: input.butlerData,
          sessionId: input.sessionId,
          sessionBindingStore: input.sessionBindingStore,
          workspaceReference: input.workspaceReference,
          target,
        }),
      };
    }
    if (call.name === "run_command") {
      return await prepareGuidedCommandEffect({
        args: call.args,
        butlerData: input.butlerData,
        workspacePath: activeWorkspacePath(),
        originalRequest: input.originalRequest,
      });
    }
    if (call.name === "call_mcp_tool") {
      return prepareGuidedMcpToolEffect({
        args: call.args,
        executeRegistered,
      });
    }
    if (call.name === "edit_file") {
      const planRevisionId = effectContext.work.currentPlan?.planRevisionId;
      const prior = planRevisionId && effectContext.occurrenceId
        ? input.effectJournal.find(acceptedPlanEffectId({
            workId: effectContext.work.workId,
            planRevisionId,
            capability: "edit_file",
            occurrenceId: effectContext.occurrenceId,
          }))
        : null;
      const prepared = await prepareGuidedWorkspaceFileEdit({
        args: call.args,
        workspacePath: activeWorkspacePath(),
        butlerData: input.butlerData,
        ...(prior ? { priorInputSha256: prior.inputSha256 } : {}),
        ...(prior?.recoveryHint
          ? { priorRecoveryHint: prior.recoveryHint }
          : {}),
        executeEditFile: async (preparedInput) => executeRegistered({
          args: preparedInput,
          rawArguments: JSON.stringify(preparedInput),
        }),
      });
      return prepared.ok ? prepared.effect : { error: prepared.error };
    }
    if (call.name === "write_file") {
      const adapter = createGuidedWorkspaceFileEffectAdapter({
        workspacePath: activeWorkspacePath(),
        butlerData: input.butlerData,
        executeWriteFile: async (preparedInput) => executeRegistered({
          args: preparedInput,
          rawArguments: JSON.stringify(preparedInput),
        }),
      });
      const normalizedInput = adapter.normalizeInput(call.args);
      return {
        target: workspaceFileEffectTarget(normalizedInput.path),
        input: normalizedInput,
        adapter,
      };
    }
    if (
      !isGuidedProjectLedgerEffectTool(call.name) ||
      input.trackingMode !== "ledger" ||
      !input.projectId
    ) {
      return null;
    }
    const ledgerLookup = {
      appProjectId: input.projectId,
      workspacePath: activeWorkspacePath(),
    };
    const resolveActiveProjectReference = () => {
      input.projectLedgerResolver.clear();
      return input.projectLedgerResolver.resolve({
        butlerData: input.butlerData,
        ...ledgerLookup,
      });
    };
    const projectReference = resolveActiveProjectReference();
    const projectRoot = projectReference.ledger_root;
    let effect: ReturnType<typeof createGuidedProjectLedgerEffectAdapter>;
    try {
      effect = createGuidedProjectLedgerEffectAdapter({
        name: call.name,
        args: call.args,
        butlerData: input.butlerData,
        projectRoot,
        projectRef: input.projectId,
        workspacePath: activeWorkspacePath(),
        resolveActiveProjectReference,
        ...(call.name === "project_ledger_create"
          ? {
              initializeForCreate() {
                const initialized = ensureActiveProjectLedger({
                  resolver: input.projectLedgerResolver,
                  butlerHome: input.butlerHome,
                  butlerData: input.butlerData,
                  lookup: ledgerLookup,
                  reference: projectReference,
                });
                if (initialized.ledger_root !== projectRoot) {
                  throw new Error(
                    "Project Ledger identity changed before the reviewed effect was applied",
                  );
                }
              },
            }
          : {}),
        memoryAttribution: input.memoryAttribution,
      });
    } catch (error) {
      if (!(error instanceof GitEvidenceCollectionError)) throw error;
      const gitMissing = error.code === "git_not_installed";
      return {
        error: {
          code: error.code,
          message: gitMissing
            ? `Git is not installed. Butler can continue without Git; install it from ${GIT_INSTALL_URL} to attach commit evidence.`
            : error.message,
          recoverable: true,
        },
      };
    }
    return {
      target: effect.target,
      input: effect.normalizedInput,
      adapter: effect.adapter,
    };
  };
}

export function sameGuidedEffectJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function acceptedGuidedPlanActionKey(
  work: DurableWorkView,
  capability: string,
  target: string,
):
  | { ok: true; value: string }
  | { ok: false; code: string; message: string } {
  const actions = work.currentPlan?.actions.filter((action) =>
    action.effect?.capability === capability && action.effect.target === target,
  ) ?? [];
  if (actions.length === 0) {
    return {
      ok: false,
      code: "effect_action_not_found",
      message: "No accepted Plan action matches this effect capability and target.",
    };
  }
  if (actions.length !== 1) {
    return {
      ok: false,
      code: "effect_action_ambiguous",
      message: "More than one accepted Plan action matches this effect.",
    };
  }
  return { ok: true, value: actions[0]!.actionKey };
}

export async function loadGuidedEffectWork(
  service: DurableWorkService,
  scope: WorkTurnScope,
): Promise<DurableWorkView | null> {
  try {
    return await service.boundWorkForTurn(scope.turnId);
  } catch {
    return null;
  }
}

export function unavailableGuidedEffect(toolName: string): Record<string, unknown> {
  return ordinaryGuidedEffectError(
    "effect_adapter_unavailable",
    `${toolName} cannot make persistent or external changes in this R3 runtime. Use an available typed effect tool or report the limitation.`,
  );
}

export function ordinaryGuidedEffectError(
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ok: false,
    error: {
      code,
      message,
      recoverable: true,
      next_action: "Amend or review the current Plan, choose a safe typed tool, or report the concrete limitation.",
      ...details,
    },
  };
}

export function deferredGuidedAuthorityResult(): Record<string, unknown> {
  return {
    ok: true,
    authority_pending: true,
    status: "awaiting_allow",
    message: "This reviewed command is waiting for Allow before dispatch.",
  };
}

export function guidedEffectReceipt(
  result: unknown,
  receipt: Record<string, unknown>,
): Record<string, unknown> {
  const resultRecord = result && typeof result === "object" && !Array.isArray(result)
    ? result as Record<string, unknown>
    : undefined;
  const startLine = typeof resultRecord?.start_line === "number"
    ? resultRecord.start_line
    : undefined;
  const publicReceipt = startLine === undefined
    ? receipt
    : { ...receipt, start_line: startLine };
  if (result && typeof result === "object" && !Array.isArray(result)) {
    return {
      ...result as Record<string, unknown>,
      effect_receipt: publicReceipt,
    };
  }
  return { ok: true, result, effect_receipt: publicReceipt };
}
