import type { GuidedEffectJournal } from "../effects/index.ts";
import type { GuidedToolJournal } from "../ports/index.ts";
import { RoundToolSurfaceError } from "../ports/model-round.ts";
import type { DurableWorkService, WorkTurnScope } from "../work/index.ts";
import type { DurableWorkExecutionMode, DurableWorkView } from "../work/index.ts";
import { isDurableWorkTool } from "../work/index.ts";
import type {
  DelegationPacket,
  SubsessionDelegationService,
} from "../subsessions/index.ts";
import { BUTLER_TOOLS } from "../../tools/butler-tools.ts";
import type { ButlerToolExecutor } from "../../tools/butler-tools.ts";
import { normalizeGuidedToolCall } from "../../tools/tool-call-normalization.ts";
import type { BtccAgentLoopInput, BtccAgentLoopToolDefinition } from "./contracts.ts";
import { projectDurableWorkToolSurface } from "./durable-work-tool-surface.ts";
import {
  createRoundToolSurfaceSnapshot,
  type BtccRoundToolSurfaceSnapshot,
} from "./round-tool-surface.ts";
const WORKER_MANAGEMENT_TOOLS = new Set([
  "delegate_to_worker",
  "steer_worker",
  "wait_for_worker",
]);
const STEWARD_MANAGEMENT_TOOLS = new Set([
  "delegate_to_steward", "steer_steward", "cancel_steward",
]);
const EXECUTION_CONTEXT_TOOLS = new Set([
  "tool_search", "tool_describe", "read_operation_results",
  "read_tool_output_artifact", "read_tool_evidence_artifact",
]);
const ACTIVE_DELEGATION_TOOLS = new Set([
  "start_work",
  "steer_steward",
  "cancel_steward",
  "steer_worker",
  "wait_for_worker",
]);
const EFFECT_FREE_TOOL_NAMES = new Set(
  BUTLER_TOOLS
    .filter((tool) => tool.effectBoundary === "none")
    .map((tool) => tool.name),
);

export function createGuidedRoundToolSurfaceResolver(input: {
  turnId: string;
  tools: readonly BtccAgentLoopToolDefinition[];
  requiredToolNames: ReadonlySet<string>;
  toolJournal: Pick<GuidedToolJournal, "list">;
  durableWork: DurableWorkService;
  workScope: WorkTurnScope;
  effectJournal: Pick<GuidedEffectJournal, "listForWork">;
  parentSessionId?: string;
  subsessionDelegation?: Pick<SubsessionDelegationService, "activeParentDelegations">;
  onActiveDelegationAdmission?: (active: boolean) => void;
  shouldWaitForWorker?: () => Promise<boolean>;
  /** A successful handoff gets one tool-free round for the role's natural reply. */
  turnReleaseDelegationTool?: "delegate_to_steward";
}): () => Promise<BtccRoundToolSurfaceSnapshot> {
  return async () => {
    if (input.turnReleaseDelegationTool && input.toolJournal.list(input.turnId)
      .some((record) =>
        record.toolName === input.turnReleaseDelegationTool &&
        record.status === "completed" &&
        isQueuedDelegationResult(record.result),
      )) {
      return createRoundToolSurfaceSnapshot([]);
    }
    const activeDelegations = input.parentSessionId && input.subsessionDelegation
      ? await input.subsessionDelegation.activeParentDelegations({
          parentSessionId: input.parentSessionId,
        })
      : [];
    if (await input.shouldWaitForWorker?.()) {
      return createRoundToolSurfaceSnapshot(input.tools);
    }
    const { bound, work } = await currentWork(input);
    const activeDelegationAdmission = activeDelegations.length > 0 &&
      (!bound && activeDelegations.some((delegation) =>
        sameCurrentReviewedWork(work, delegation.parent_work_ref)));
    input.onActiveDelegationAdmission?.(activeDelegationAdmission);
    const tools = projectDurableWorkToolSurface(input.tools, work);
    const names = new Set(tools.map((tool) => tool.name));
    const missingRequired = [...input.requiredToolNames]
      .find((name) => input.tools.some((tool) => tool.name === name) && !names.has(name));
    if (missingRequired) {
      throw new RoundToolSurfaceError("round_tool_surface_required_tool_missing");
    }
    return createRoundToolSurfaceSnapshot(tools);
  };
}

function isQueuedDelegationResult(result: unknown): boolean {
  return Boolean(
    result && typeof result === "object" &&
    Reflect.get(result, "ok") === true &&
    Reflect.get(result, "status") === "queued",
  );
}

function sameCurrentReviewedWork(
  work: DurableWorkView | undefined,
  parentWorkRef: DelegationPacket["parent_work_ref"],
): boolean {
  const plan = work?.currentPlan;
  const review = work?.latestPlanReview;
  if (!work || (work.status !== "open" && work.status !== "blocked") ||
    !plan || review?.subject !== "plan" ||
    review.verdict !== "accept" ||
    review.boundPlanRevisionId !== plan.planRevisionId) return false;
  return work.workId === parentWorkRef.work_id &&
    work.sessionId === parentWorkRef.session_id &&
    plan.planRevisionId === parentWorkRef.plan_revision_id &&
    review.reviewRevisionId === parentWorkRef.review_revision_id;
}

function isActiveDelegationAdmissionTool(name: string): boolean {
  return EFFECT_FREE_TOOL_NAMES.has(name) || ACTIVE_DELEGATION_TOOLS.has(name);
}

export function createActiveDelegationAdmissionGuard(
  shouldWaitForWorker?: () => Promise<boolean>,
  work?: {
    role: "butler" | "steward" | "worker";
    turnId: string;
    durableWork: DurableWorkService;
    workScope: WorkTurnScope;
    workerResultIntegration?: boolean;
  },
): {
  observe(active: boolean): void;
  execute(execute: ButlerToolExecutor): BtccAgentLoopInput["executeTool"];
} {
  let active = false;
  return {
    observe(value) {
      active = value;
    },
    execute(execute) {
      return async (call) => {
        const effective = normalizeGuidedToolCall({ toolName: call.name, args: call.arguments });
        // Recheck immediately before execution: an earlier call in this same
        // response may have assigned a Worker after the round surface was built.
        const workerOutstanding = await shouldWaitForWorker?.() ?? false;
        if (!WORKER_MANAGEMENT_TOOLS.has(effective.name) &&
          !EXECUTION_CONTEXT_TOOLS.has(effective.name) && workerOutstanding) {
          return {
            ok: false,
            error: {
              code: "tool_unavailable",
              message: "Worker execution or an unconsumed result is outstanding. Manage Workers and wait; this execution call was not run.",
            },
          };
        }
        if (active && !isActiveDelegationAdmissionTool(effective.name)) {
          return {
            ok: false,
            error: {
              code: "active_delegated_work_tool_forbidden",
              message: "This fresh Turn cannot continue, mutate, execute, or re-delegate the active Steward-owned Work.",
            },
          };
        }
        if (work && effective.name === "replace_work_plan") {
          const mode = effective.args.execution_mode;
          if ((mode === "steward" && work.role !== "butler") ||
            (mode === "workers" && work.role !== "steward")) {
            return { ok: false, error: { code: "tool_unavailable",
              message: `This ${work.role} Plan cannot use execution_mode: ${mode}. Butler chooses direct or steward; Steward chooses direct or workers; Worker chooses direct. The Plan was not changed.` } };
          }
        }
        const current = work
          ? await work.durableWork.boundWorkForTurn(work.turnId)
          : undefined;
        const executionMode = current?.currentPlan?.executionMode;
        const executingPlan = current?.currentStage === "execution";
        if (work?.role === "butler" && executingPlan && effective.name === "delegate_to_steward" &&
          executionMode !== "steward") {
          return unavailableForExecutionMode(executionMode, "butler");
        }
        if (work?.role === "butler" && executingPlan && executionMode === "steward" &&
          isPlanExecutionCall(effective.name)) {
          return unavailableForExecutionMode(executionMode);
        }
        if (work?.role === "steward" && executingPlan && effective.name === "delegate_to_worker" &&
          executionMode !== "workers" && !workerOutstanding) {
          return unavailableForExecutionMode(executionMode);
        }
        if (work?.role === "steward" && executingPlan && isPlanExecutionCall(effective.name) &&
          executionMode !== "direct" &&
          !(work?.workerResultIntegration && isIntegrationReadOrValidation(effective))) {
          return unavailableForExecutionMode(executionMode);
        }
        return await execute({
          name: call.name,
          args: call.arguments,
          rawArguments: call.rawArguments,
          providerCallId: call.id,
          signal: call.signal,
        });
      };
    },
  };
}

function isPlanExecutionCall(name: string): boolean {
  return !WORKER_MANAGEMENT_TOOLS.has(name) && !STEWARD_MANAGEMENT_TOOLS.has(name) &&
    !EXECUTION_CONTEXT_TOOLS.has(name) && !isDurableWorkTool(name);
}

function isIntegrationReadOrValidation(call: { name: string; args: Record<string, unknown> }): boolean {
  return EFFECT_FREE_TOOL_NAMES.has(call.name) ||
    (call.name === "run_command" &&
      (call.args.state_effect === "read_only" || call.args.state_effect === "validation"));
}

function unavailableForExecutionMode(mode: DurableWorkExecutionMode | undefined, role: "butler" | "steward" = "steward") {
  const message = role === "butler"
    ? "To delegate this Work, revise the same Plan with execution_mode: steward, preserving completed action keys and results, then review and call delegate_to_steward. This delegation call was not run."
    : mode === "steward"
    ? "The reviewed Plan assigns execution to Steward. Call delegate_to_steward with the remaining objective and constraints; Butler manages and reports the result. This execution call was not run."
    : mode === "workers"
    ? "The reviewed Plan assigns execution to Workers. Use Worker management for execution; Steward retains integration, review, validation, and reporting."
    : mode === "direct"
      ? "The reviewed Plan assigns execution directly to Steward; Worker assignment is unavailable for this Plan."
      : "The current Plan has no reviewed execution ownership. Replace and review the Plan with direct or workers before new owned execution.";
  return { ok: false, error: { code: "tool_unavailable", message } };
}

async function currentWork(input: {
  turnId: string;
  durableWork: DurableWorkService;
  workScope: WorkTurnScope;
}): Promise<{
  bound: DurableWorkView | undefined;
  work: DurableWorkView | undefined;
}> {
  const bound = await input.durableWork.boundWorkForTurn(input.turnId);
  const context = bound
    ? null
    : await input.durableWork.loadContext(input.workScope);
  return {
    bound: bound ?? undefined,
    work: bound ?? context?.work ?? undefined,
  };
}
