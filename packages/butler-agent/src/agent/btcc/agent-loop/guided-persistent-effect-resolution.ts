import type { SqliteGuidedEffectJournal } from "../../adapters/index.ts";
import type { ButlerExecutionPolicy } from "../contracts.ts";
import { acceptedPlanEffectId } from "../effects/index.ts";
import type { ActiveProjectLedgerResolver } from
  "../../../integrations/project-ledger/active-project-ledger-reference.ts";
import { ensureActiveProjectLedger } from
  "../../../integrations/project-ledger/ensure-active-project-ledger.ts";
import type { ButlerToolCall } from "../../tools/butler-tools.ts";
import type {
  GuidedPersistentEffectContext,
  GuidedPersistentEffectResolution,
} from "./guided-tool-execution-boundary.ts";
import {
  createGuidedProjectLedgerEffectAdapter,
  isGuidedProjectLedgerEffectTool,
} from "./guided-project-ledger-effect.ts";
import { prepareGuidedCommandEffect } from "./guided-command-effect.ts";
import {
  createGuidedWorkspaceFileEffectAdapter,
  workspaceFileEffectTarget,
} from "./guided-workspace-file-effect.ts";
import { prepareGuidedWorkspaceFileEdit } from
  "./guided-workspace-file-edit-effect.ts";

type ExecuteRegisteredTool = (prepared?: {
  args: ButlerToolCall["args"];
  rawArguments?: ButlerToolCall["rawArguments"];
}) => Promise<unknown>;

export function createGuidedPersistentEffectResolver(input: {
  butlerHome: string;
  butlerData: string;
  appMessageDbPath: string;
  workspacePath: string;
  projectId?: string;
  trackingMode: ButlerExecutionPolicy["trackingMode"];
  projectLedgerResolver: ActiveProjectLedgerResolver;
  effectJournal: Pick<SqliteGuidedEffectJournal, "find">;
  originalRequest: string;
}): (
  call: ButlerToolCall,
  executeRegistered: ExecuteRegisteredTool,
  effectContext: GuidedPersistentEffectContext,
) => Promise<GuidedPersistentEffectResolution | null> {
  return async (call, executeRegistered, effectContext) => {
    if (call.name === "run_command") {
      return await prepareGuidedCommandEffect({
        args: call.args,
        butlerData: input.butlerData,
        workspacePath: input.workspacePath,
        originalRequest: input.originalRequest,
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
        workspacePath: input.workspacePath,
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
        workspacePath: input.workspacePath,
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
      appMessageDbPath: input.appMessageDbPath,
      appProjectId: input.projectId,
      workspacePath: input.workspacePath,
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
    const effect = createGuidedProjectLedgerEffectAdapter({
      name: call.name,
      args: call.args,
      butlerData: input.butlerData,
      projectRoot,
      projectRef: input.projectId,
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
    });
    return {
      target: effect.target,
      input: effect.normalizedInput,
      adapter: effect.adapter,
    };
  };
}
