import {
  createGuidedEffectService,
  type DurableWorkService,
  type GuidedTurnAgent,
  type GuidedTurnResult,
} from "../../btcc/index.ts";
import { createButlerToolExecutor } from "../../tools/butler-tools.ts";
import type {
  SqliteGuidedEffectJournal,
  SqliteGuidedToolJournal,
} from
  "../../adapters/index.ts";
import { ActiveProjectLedgerResolver } from
  "../../../integrations/project-ledger/active-project-ledger-reference.ts";
import { ensureActiveProjectLedger } from
  "../../../integrations/project-ledger/ensure-active-project-ledger.ts";
import { runFunctionToolPromptText } from
  "../../../integrations/providers/runtime.ts";
import { MAX_TOOL_ROUNDS } from
  "../../../integrations/providers/shared/runtime-support.ts";
import type { FunctionToolPromptOptions } from
  "../../../integrations/providers/runtime-contracts.ts";
import {
  guidedInstructions,
  providerImageAttachments,
  renderGuidedPrompt,
} from "./guided-turn-prompt.ts";
import {
  authorizedToolDefinitions,
  GUIDED_NATIVE_TOOL_AVAILABILITY_OVERRIDES,
  guidedPolicy,
  hiddenNativeToolNamesForGuidedTurn,
  routeForUsedTools,
  selectedModelRef,
  visibleToolDefinitions,
} from "./guided-turn-policy.ts";
import { createGuidedToolExecutionBoundary } from
  "./guided-tool-execution-boundary.ts";
import {
  createGuidedProjectLedgerEffectAdapter,
  isGuidedProjectLedgerEffectTool,
} from "./guided-project-ledger-effect.ts";
import { executeGuidedCommandCall } from "./guided-command-execution.ts";
import { renderGuidedEffectContext } from "./guided-effect-context.ts";
import {
  createGuidedWorkspaceFileEffectAdapter,
  workspaceFileEffectTarget,
} from "./guided-workspace-file-effect.ts";
import { renderDurableWorkContext } from "./durable-work-tools.ts";
import {
  backfillTurnToolResults,
  safeImportOpenLegacyWork,
  safeBoundWork,
  safeLoadWorkContext,
  workScopeForTurn,
} from "./guided-work-runtime.ts";
import { createGuidedToolCallExecutor } from
  "./guided-tool-call-execution.ts";
import { runGuidedPromptWithOperationalReport } from
  "./guided-operational-report.ts";

type PromptRunner = (options: FunctionToolPromptOptions) => Promise<string>;

export function createProductionGuidedTurnAgent(input: {
  butlerHome: string;
  butlerData: string;
  appMessageDbPath: string;
  contextDocuments: { resolve(contextRef: string): string };
  toolJournal: SqliteGuidedToolJournal;
  effectJournal: SqliteGuidedEffectJournal;
  durableWork: DurableWorkService;
  promptRunner?: PromptRunner;
  turnLeaseMs?: number;
  finalReportMs?: number;
}): GuidedTurnAgent {
  const promptRunner = input.promptRunner ?? runFunctionToolPromptText;
  const projectLedgerResolver = new ActiveProjectLedgerResolver();
  return {
    async run({ turn, signal, progress }): Promise<GuidedTurnResult> {
      const leaseStartedAt = Date.now();
      const policy = guidedPolicy(turn);
      const workScope = workScopeForTurn(turn, policy.trackingMode);
      let initialWork = policy.trackingMode === "none"
        ? null
        : await safeLoadWorkContext(input.durableWork, workScope);
      if (!initialWork && policy.trackingMode !== "none") {
        await safeImportOpenLegacyWork(input.durableWork, workScope);
        initialWork = await safeLoadWorkContext(input.durableWork, workScope);
      }
      if (initialWork) {
        const boundWork = await safeBoundWork(input.durableWork, turn.turnId);
        if (boundWork?.workId === initialWork.work.workId) {
          await backfillTurnToolResults(input, workScope);
          initialWork = await safeLoadWorkContext(input.durableWork, workScope);
        }
      }
      const presentedWorkId = initialWork?.work.workId;
      const authorizedTools = authorizedToolDefinitions(turn);
      const authorizedNames = new Set(authorizedTools.map((tool) => tool.name));
      const visibleTools = visibleToolDefinitions(authorizedTools, policy);
      const visibleNames = new Set(visibleTools.map((tool) => tool.name));
      const describedToolIds = new Set<string>();
      const effectService = createGuidedEffectService(input.effectJournal);
      const execute = createButlerToolExecutor({
        butlerHome: input.butlerHome,
        butlerData: input.butlerData,
        appMessageDbPath: input.appMessageDbPath,
        workspacePath: policy.workspacePath,
        sessionId: turn.sessionId,
        originChatId: turn.sessionId,
        projectId: policy.projectId ?? turn.context.projectRef,
        turnId: turn.turnId,
        turnContext: turn.originalMessage,
        searchPlannerOriginalRequest: turn.originalMessage,
        workerModel: selectedModelRef(turn),
        searchPlannerModel: selectedModelRef(turn),
        currentToolNames: () => [...authorizedNames],
        hiddenNativeToolNames: hiddenNativeToolNamesForGuidedTurn(
          policy.accessMode === "full_access" &&
            policy.trackingMode === "ledger" &&
            Boolean(policy.projectId),
        ),
        nativeToolAvailabilityOverrides:
          GUIDED_NATIVE_TOOL_AVAILABILITY_OVERRIDES,
        describedToolIds: () => [...describedToolIds],
        executionBoundary: createGuidedToolExecutionBoundary({
          durableWork: input.durableWork,
          workScope,
          effectService,
          accessMode: policy.accessMode,
          signal,
          executeCommand: (call) => executeGuidedCommandCall({
            call,
            accessMode: policy.accessMode,
            butlerData: input.butlerData,
            workspacePath: policy.workspacePath,
            originalRequest: turn.originalMessage,
            signal,
          }),
          resolvePersistentEffect(call, executeRegistered) {
            if (call.name === "write_file") {
              const adapter = createGuidedWorkspaceFileEffectAdapter({
                workspacePath: policy.workspacePath,
                butlerData: input.butlerData,
                executeWriteFile: async () => executeRegistered(),
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
              policy.trackingMode !== "ledger" ||
              !policy.projectId
            ) {
              return null;
            }
            const ledgerLookup = {
              appMessageDbPath: input.appMessageDbPath,
              appProjectId: policy.projectId,
              workspacePath: policy.workspacePath,
            };
            const resolveActiveProjectReference = () => {
              projectLedgerResolver.clear();
              return projectLedgerResolver.resolve({
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
              projectRef: policy.projectId,
              resolveActiveProjectReference,
              ...(call.name === "project_ledger_create"
                ? {
                    initializeForCreate() {
                      const initialized = ensureActiveProjectLedger({
                        resolver: projectLedgerResolver,
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
          },
        }),
      });
      const toolCalls = createGuidedToolCallExecutor({
        turn,
        signal,
        progress,
        workScope,
        presentedWorkId,
        authorizedNames,
        visibleNames,
        describedToolIds,
        durableWork: input.durableWork,
        toolJournal: input.toolJournal,
        executeButlerTool: execute,
      });
      const promptOptions: FunctionToolPromptOptions = {
        prompt: renderGuidedPrompt(turn, {
          ...input,
          workContext: renderDurableWorkContext(initialWork),
          effectContext: initialWork
            ? renderGuidedEffectContext(
                input.effectJournal.listForWork(initialWork.work.workId),
              )
            : "",
        }),
        instructions: guidedInstructions(policy),
        model: selectedModelRef(turn),
        reasoningEffort: turn.modelSelection.reasoningEffort,
        cacheScope: `btcc-guided:${turn.sessionId}`,
        signal,
        butlerData: input.butlerData,
        attachments: providerImageAttachments(turn),
        tools: visibleTools,
        maxToolRounds: MAX_TOOL_ROUNDS,
        executeTool: toolCalls.executeTool,
      };
      const text = await runGuidedPromptWithOperationalReport({
        promptRunner,
        options: promptOptions,
        parentSignal: signal,
        leaseStartedAt,
        leaseMs: input.turnLeaseMs,
        finalReportMs: input.finalReportMs,
        async loadFacts() {
          const currentWork = await safeLoadWorkContext(input.durableWork, workScope) ??
            await safeBoundWork(input.durableWork, turn.turnId) ?? initialWork;
          const workId = currentWork && "work" in currentWork
            ? currentWork.work.workId
            : currentWork?.workId;
          return {
            originalRequest: turn.originalMessage,
            work: currentWork,
            toolCalls: input.toolJournal.list(turn.turnId),
            effects: workId ? input.effectJournal.listForWork(workId) : [],
          };
        },
      });
      return {
        content: text,
        route: routeForUsedTools(
          toolCalls.usedTools,
          Boolean(await safeBoundWork(input.durableWork, turn.turnId)),
        ),
      };
    },
  };
}
