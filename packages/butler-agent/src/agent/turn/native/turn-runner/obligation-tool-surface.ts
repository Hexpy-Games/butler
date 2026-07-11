import type { FunctionToolDefinition } from "../../../../integrations/providers/provider.ts";
import type { CompiledTurnContract } from "../../turn-contract-types.ts";
import {
  isStateMutatingToolCall,
  isStaticallyReadOnlyToolName,
} from "../../tool-loop-guards.ts";
import { isInternalProgressTool } from "../progress/runtime-semantic-progress.ts";
import { isStatusReportEvidenceTool } from "./turn-contract-status-evidence.ts";
import {
  explicitPlanArguments,
  requireExplicitPlanUpdate,
} from "./turn-contract-plan-admission.ts";
import { turnContractActionRequiresExplicitPlan } from "../../turn-contract-plan-closure.ts";

type LedgerRecordKind = "spec" | "work" | "task";
export type ObligationToolSurfaceStage =
  | "open"
  | "work_planning"
  | "ledger"
  | "workspace_execution"
  | "workspace_action"
  | "workspace_validation"
  | "workspace_repair"
  | "status_inspection"
  | "closeout";

export const WORKSPACE_INSPECTION_MAX_CONSECUTIVE_READS = 12;
export const TURN_FORWARD_PROGRESS_STALLED_CODE = "turn_forward_progress_stalled";

export type ObligationToolAdmission =
  | { allowed: true }
  | {
    allowed: false;
    code: "workspace_action_required";
    message: string;
    terminal: boolean;
  };

export class TurnForwardProgressStalledError extends Error {
  readonly code = TURN_FORWARD_PROGRESS_STALLED_CODE;

  constructor() {
    super(`${TURN_FORWARD_PROGRESS_STALLED_CODE}: two provider-visible repair responses violated the focused workspace-action frontier`);
    this.name = "TurnForwardProgressStalledError";
  }
}

const LEDGER_DELIVERABLE_KINDS = new Map<string, LedgerRecordKind>([
  ["ledger_spec", "spec"],
  ["ledger_work", "work"],
  ["ledger_tasks", "task"],
]);

const LEDGER_RECORD_DEPENDENCY_ORDER: readonly LedgerRecordKind[] = ["spec", "work", "task"];

const LEGACY_LEDGER_TOOLS = new Set([
  "inspect_project_status",
  "query_project_work",
  "get_work_dashboard",
  "complete_project_work",
  "render_project_dashboard",
]);

const CLOSEOUT_TOOLS = new Set([
  "project_ledger_update",
  "project_ledger_check",
  "project_ledger_work_update",
  "project_ledger_work_complete",
  "project_ledger_task_update",
  "project_ledger_task_complete",
  "update_todo_list",
]);

const LEDGER_OBLIGATION_MUTATION_TOOLS = new Set([
  "project_ledger_create",
  "project_ledger_update",
  "project_ledger_work_update",
  "project_ledger_work_complete",
  "project_ledger_task_update",
  "project_ledger_task_complete",
]);

export interface ObligationToolSurfaceState {
  planReady: boolean;
  gated: boolean;
  ledgerDiscoveryObserved: boolean;
  ledgerDiscoveryCandidateCount: number;
  requiredLedgerKinds: LedgerRecordKind[];
  observedLedgerKinds: LedgerRecordKind[];
  ledgerCheckPassed: boolean;
  workspaceMutationObserved: boolean;
  workspaceInspectionCount: number;
  workspaceActionFocused: boolean;
  workspaceActionRejections: number;
  validationObserved: boolean;
  validationFailed: boolean;
  validationFocused: boolean;
  statusObserved: boolean;
  statusFocused: boolean;
  stage: ObligationToolSurfaceStage;
}

export interface ObligationToolSurfaceSeed {
  planReady?: boolean;
  ledgerDiscoveryObserved?: boolean;
  ledgerDiscoveryCandidateCount?: number;
  observedLedgerKinds?: readonly LedgerRecordKind[];
  ledgerCheckPassed?: boolean;
  workspaceMutationObserved?: boolean;
  workspaceInspectionCount?: number;
  workspaceActionFocused?: boolean;
  workspaceActionRejections?: number;
  validationObserved?: boolean;
  validationFailed?: boolean;
  validationFocused?: boolean;
  statusObserved?: boolean;
  statusFocused?: boolean;
}

export interface ObligationToolSurfaceController {
  project(tools: readonly FunctionToolDefinition[]): FunctionToolDefinition[];
  authorize(input: {
    name: string;
    args: Record<string, unknown>;
  }): ObligationToolAdmission;
  assertCanContinue(): void;
  observe(input: {
    name: string;
    args: Record<string, unknown>;
    result: unknown;
  }): ObligationToolAdmission | null;
  focusMissingDeliverables(deliverables: readonly string[]): void;
  state(): ObligationToolSurfaceState;
}

export interface ObligationToolSurfaceSession {
  controllerFor(
    contract: CompiledTurnContract | null | undefined,
    seed?: ObligationToolSurfaceSeed,
  ): ObligationToolSurfaceController;
  focusMissingDeliverables(deliverables: readonly string[]): void;
  assertCanContinue(): void;
  state(): ObligationToolSurfaceState;
}

export function createObligationToolSurfaceSession(input: {
  resolvePlanReady?: (contract: CompiledTurnContract) => boolean;
} = {}): ObligationToolSurfaceSession {
  let contractId: string | null = null;
  let controller = createObligationToolSurfaceController(null);
  return {
    controllerFor(contract, seed) {
      const nextContractId = contract?.contract_id ?? null;
      if (nextContractId !== contractId) {
        contractId = nextContractId;
        controller = createObligationToolSurfaceController(contract, {
          ...seed,
          planReady: seed?.planReady === true || Boolean(
            contract && input.resolvePlanReady?.(contract),
          ),
        });
      }
      return controller;
    },
    focusMissingDeliverables: (deliverables) => controller.focusMissingDeliverables(deliverables),
    assertCanContinue: () => controller.assertCanContinue(),
    state: () => controller.state(),
  };
}

export function createObligationToolSurfaceController(
  contract: CompiledTurnContract | null | undefined,
  seed: ObligationToolSurfaceSeed = {},
): ObligationToolSurfaceController {
  const requiredLedgerKinds = new Set<LedgerRecordKind>();
  for (const deliverable of contract?.deliverables ?? []) {
    const kind = LEDGER_DELIVERABLE_KINDS.get(deliverable);
    if (kind) requiredLedgerKinds.add(kind);
  }
  const workAction = Boolean(
    contract && turnContractActionRequiresExplicitPlan(contract.action),
  );
  const requiresExplicitPlan = workAction;
  let planReady = !requiresExplicitPlan || seed.planReady === true;
  const requiresCodeChange = contract?.deliverables.includes("code_change") ?? false;
  const requiresValidation = contract?.deliverables.includes("validation") ?? false;
  const hasWorkspaceDeliverable = requiresCodeChange || requiresValidation;
  const ledgerFirst = Boolean(
    workAction && contract?.tracking_mode === "ledger" &&
    requiredLedgerKinds.size > 0 && hasWorkspaceDeliverable,
  );
  const managed = workAction && (ledgerFirst || hasWorkspaceDeliverable);
  const observedLedgerKinds = new Set(
    (seed.observedLedgerKinds ?? []).filter((kind) => requiredLedgerKinds.has(kind)),
  );
  let mutationSequence = observedLedgerKinds.size;
  let ledgerDiscoveryObserved = seed.ledgerDiscoveryObserved === true || mutationSequence > 0;
  let ledgerDiscoveryCandidateCount = Math.max(
    0,
    Math.floor(seed.ledgerDiscoveryCandidateCount ?? 0),
  );
  let checkedMutationSequence = seed.ledgerCheckPassed ? mutationSequence : -1;
  let workspaceMutationObserved = seed.workspaceMutationObserved === true;
  const workspaceMutationOutstanding = () =>
    requiresCodeChange && !workspaceMutationObserved;
  let workspaceInspectionCount = workspaceMutationOutstanding()
    ? Math.min(
      WORKSPACE_INSPECTION_MAX_CONSECUTIVE_READS,
      nonNegativeInteger(seed.workspaceInspectionCount),
    )
    : 0;
  let workspaceActionFocused = workspaceMutationOutstanding() && (
    seed.workspaceActionFocused === true ||
    workspaceInspectionCount >= WORKSPACE_INSPECTION_MAX_CONSECUTIVE_READS
  );
  let workspaceActionRejections = workspaceActionFocused
    ? nonNegativeInteger(seed.workspaceActionRejections)
    : 0;
  let validationObserved = seed.validationObserved === true;
  let validationFailed = seed.validationFailed === true && !validationObserved;
  let validationFocused = seed.validationFocused === true && !validationObserved;
  const requiresStatusReport = contract?.deliverables.includes("status_report") ?? false;
  let statusObserved = seed.statusObserved === true;
  let statusFocused = seed.statusFocused === true;

  const gated = () => ledgerFirst && !(
    mutationSequence > 0 && checkedMutationSequence === mutationSequence &&
    [...requiredLedgerKinds].every((kind) => observedLedgerKinds.has(kind))
  );
  const stage = (): ObligationToolSurfaceStage => {
    if (requiresExplicitPlan && !planReady) return "work_planning";
    if (requiresStatusReport && statusFocused) return "status_inspection";
    if (!managed) return "open";
    if (gated()) return "ledger";
    if (workspaceMutationOutstanding() && workspaceActionFocused) {
      return "workspace_action";
    }
    if (requiresValidation && validationFocused && !validationObserved) {
      return validationFailed ? "workspace_repair" : "workspace_validation";
    }
    return "workspace_execution";
  };

  return {
    project(tools) {
      const runtimeOwnedLifecycleFiltered = contract?.target_workstream_id
        ? tools.filter((tool) => tool.name !== "update_work_stream_state")
        : tools;
      switch (stage()) {
        case "open":
          return [...runtimeOwnedLifecycleFiltered];
        case "work_planning":
          return runtimeOwnedLifecycleFiltered
            .filter((tool) => tool.name === "update_todo_list" || isInternalProgressTool(tool.name))
            .map(requireExplicitPlanUpdate);
        case "ledger": {
          const remainingLedgerKinds = remainingRequiredLedgerKinds(
            requiredLedgerKinds,
            observedLedgerKinds,
          );
          return runtimeOwnedLifecycleFiltered
            .filter((tool) => ledgerPhaseAllows(tool.name, {
            discoveryObserved: ledgerDiscoveryObserved,
            discoveryCandidateCount: ledgerDiscoveryCandidateCount,
            allRequiredKindsObserved: [...requiredLedgerKinds]
              .every((kind) => observedLedgerKinds.has(kind)),
            checkPending: checkedMutationSequence !== mutationSequence,
            }))
            .filter((tool) =>
              tool.name !== "project_ledger_create" || remainingLedgerKinds.length > 0)
            .map((tool) => ledgerDiscoveryTool(tool, ledgerDiscoveryObserved))
            .map((tool) => ledgerCreationTool(tool, remainingLedgerKinds));
        }
        case "workspace_execution":
        case "workspace_repair":
          return runtimeOwnedLifecycleFiltered.filter((tool) =>
            !isLedgerOnlyTool(tool.name) || CLOSEOUT_TOOLS.has(tool.name));
        case "workspace_action":
          return runtimeOwnedLifecycleFiltered
            .filter((tool) => workspaceActionSurfaceAllows(tool.name))
            .map(requireWorkspaceMutation);
        case "workspace_validation":
          return runtimeOwnedLifecycleFiltered
            .filter((tool) => tool.name === "run_command")
            .map(requireStructuredValidation);
        case "status_inspection":
          return runtimeOwnedLifecycleFiltered.filter((tool) =>
            isInternalProgressTool(tool.name) ||
            (!statusObserved && isStatusReportEvidenceTool(tool.name)));
        case "closeout":
          return runtimeOwnedLifecycleFiltered.filter((tool) =>
            CLOSEOUT_TOOLS.has(tool.name) || isInternalProgressTool(tool.name));
      }
    },
    authorize(input) {
      if (!workspaceMutationOutstanding() || !workspaceActionFocused) {
        return { allowed: true };
      }
      if (workspaceActionRejections >= 2) {
        return workspaceActionRejection(true);
      }
      if (workspaceActionCallAllowed(input.name, input.args)) return { allowed: true };
      workspaceActionRejections += 1;
      return workspaceActionRejection(workspaceActionRejections >= 2);
    },
    assertCanContinue() {
      if (
        workspaceMutationOutstanding() &&
        workspaceActionFocused &&
        workspaceActionRejections >= 2
      ) {
        throw new TurnForwardProgressStalledError();
      }
    },
    observe(input) {
      const validation = validationReceiptState(input.result);
      if (validation === "passed") {
        validationObserved = true;
        validationFailed = false;
        validationFocused = false;
      } else if (validation === "failed") {
        validationFailed = true;
      }
      if (validation) resetWorkspaceInspection();
      if (successful(input.result) && isStatusReportEvidenceTool(input.name)) {
        statusObserved = true;
        resetWorkspaceInspection();
      }
      if (
        successful(input.result) &&
        input.name === "update_todo_list" &&
        explicitPlanArguments(input.args)
      ) {
        planReady = true;
      }
      if (
        successful(input.result) &&
        input.name === "update_todo_list" &&
        planUpdateChangedState(input.result)
      ) {
        resetWorkspaceInspection();
      }
      if (!managed) return null;
      if (!successful(input.result)) {
        if (workspaceActionFocused && workspaceMutationAttempted(input.name, input.args)) {
          workspaceActionRejections += 1;
          return workspaceActionRejection(workspaceActionRejections >= 2);
        }
        return null;
      }
      if (input.name === "project_ledger_list") {
        ledgerDiscoveryObserved = true;
        ledgerDiscoveryCandidateCount = projectLedgerListCandidateCount(input.result);
      }
      const kind = ledgerRecordKindForMutation(input.name, input.args);
      if (kind) {
        ledgerDiscoveryObserved = true;
        observedLedgerKinds.add(kind);
        mutationSequence += 1;
        resetWorkspaceInspection();
      }
      if (input.name === "project_ledger_check") {
        const checkAdvanced = mutationSequence > 0 && checkedMutationSequence !== mutationSequence;
        checkedMutationSequence = mutationSequence;
        if (checkAdvanced) resetWorkspaceInspection();
      }
      if (
        workspaceMutationAttempted(input.name, input.args) &&
        workspaceMutationVerified(input.name, input.result)
      ) {
        workspaceMutationObserved = true;
        if (validationFailed) validationFailed = false;
        resetWorkspaceInspection();
        return null;
      }
      if (workspaceActionFocused && workspaceMutationAttempted(input.name, input.args)) {
        workspaceActionRejections += 1;
        return workspaceActionRejection(workspaceActionRejections >= 2);
      }
      if (
        workspaceMutationOutstanding() &&
        planReady &&
        !gated() &&
        !isInternalProgressTool(input.name) &&
        !isStateMutatingToolCall(input.name, input.args)
      ) {
        workspaceInspectionCount = Math.min(
          WORKSPACE_INSPECTION_MAX_CONSECUTIVE_READS,
          workspaceInspectionCount + 1,
        );
        if (workspaceInspectionCount >= WORKSPACE_INSPECTION_MAX_CONSECUTIVE_READS) {
          workspaceActionFocused = true;
        }
      }
      return null;
    },
    focusMissingDeliverables(deliverables) {
      if (
        requiresCodeChange &&
        deliverables.includes("code_change") &&
        workspaceMutationObserved
      ) {
        workspaceMutationObserved = false;
        resetWorkspaceInspection();
      }
      if (requiresStatusReport && deliverables.includes("status_report") && !statusObserved) {
        statusFocused = true;
      }
      if (requiresValidation && deliverables.includes("validation") && !validationObserved) {
        validationFocused = true;
      }
    },
    state: () => ({
      planReady,
      gated: gated(),
      ledgerDiscoveryObserved,
      ledgerDiscoveryCandidateCount,
      requiredLedgerKinds: [...requiredLedgerKinds].sort(),
      observedLedgerKinds: [...observedLedgerKinds].sort(),
      ledgerCheckPassed: mutationSequence > 0 && checkedMutationSequence === mutationSequence,
      workspaceMutationObserved,
      workspaceInspectionCount,
      workspaceActionFocused,
      workspaceActionRejections,
      validationObserved,
      validationFailed,
      validationFocused,
      statusObserved,
      statusFocused,
      stage: stage(),
    }),
  };

  function resetWorkspaceInspection(): void {
    workspaceInspectionCount = 0;
    workspaceActionFocused = false;
    workspaceActionRejections = 0;
  }
}

function requireStructuredValidation(tool: FunctionToolDefinition): FunctionToolDefinition {
  if (tool.name !== "run_command") return tool;
  const required = Array.isArray(tool.parameters.required)
    ? tool.parameters.required.filter((value): value is string => typeof value === "string")
    : [];
  return {
    ...tool,
    description: `${tool.description} The active typed contract is awaiting validation, so validation_suite is required.`,
    parameters: {
      ...tool.parameters,
      required: [...new Set([...required, "validation_suite"])],
    },
  };
}

function requireWorkspaceMutation(tool: FunctionToolDefinition): FunctionToolDefinition {
  if (tool.name !== "run_command") return tool;
  const parameters = recordValue(tool.parameters);
  const properties = recordValue(parameters.properties);
  const required = Array.isArray(parameters.required)
    ? parameters.required.filter((value): value is string => typeof value === "string")
    : [];
  return {
    ...tool,
    description: `${tool.description} Workspace inspection is exhausted. Declare state_effect='mutation'; the runtime also verifies that the command actually mutates state.`,
    parameters: {
      ...parameters,
      properties: {
        ...properties,
        state_effect: {
          type: "string",
          const: "mutation",
          description: "Required declaration for the focused state-changing workspace action.",
        },
      },
      required: [...new Set([...required, "state_effect"])],
    },
  };
}

function workspaceActionSurfaceAllows(name: string): boolean {
  if (name === "update_todo_list" || isInternalProgressTool(name)) return true;
  return !isLedgerOnlyTool(name) && !isStaticallyReadOnlyToolName(name);
}

function workspaceActionCallAllowed(name: string, args: Record<string, unknown>): boolean {
  if (name === "update_todo_list" || isInternalProgressTool(name)) return true;
  if (name === "run_command") return args.state_effect === "mutation";
  return isWorkspaceMutation(name, args);
}

function workspaceMutationAttempted(name: string, args: Record<string, unknown>): boolean {
  if (name === "run_command") return args.state_effect === "mutation";
  return isWorkspaceMutation(name, args);
}

function workspaceActionRejection(terminal: boolean): ObligationToolAdmission {
  return {
    allowed: false,
    code: "workspace_action_required",
    message: terminal
      ? "A later provider response again failed to produce verified workspace mutation evidence; this turn must recover from a forward-progress fault."
      : "Workspace inspection is exhausted. Perform one verified mutation or an accepted structured plan update before reading more evidence.",
    terminal,
  };
}

function ledgerPhaseAllows(name: string, state: {
  discoveryObserved: boolean;
  discoveryCandidateCount: number;
  allRequiredKindsObserved: boolean;
  checkPending: boolean;
}): boolean {
  if (!state.discoveryObserved) return name === "project_ledger_list";
  if (isInternalProgressTool(name)) return true;
  if (state.allRequiredKindsObserved) {
    return name === "project_ledger_check" && state.checkPending;
  }
  if (LEDGER_OBLIGATION_MUTATION_TOOLS.has(name)) return true;
  if (name === "project_ledger_show") return state.discoveryCandidateCount > 0;
  return false;
}

function ledgerDiscoveryTool(
  tool: FunctionToolDefinition,
  discoveryObserved: boolean,
): FunctionToolDefinition {
  if (discoveryObserved || tool.name !== "project_ledger_list") return tool;
  const parameters = recordValue(tool.parameters);
  const properties = recordValue(parameters.properties);
  return {
    ...tool,
    description: `${tool.description} This is the bounded discovery step for the active Ledger obligation. Search all matching record kinds in one call before choosing create or update.`,
    parameters: {
      ...parameters,
      properties: {
        ...properties,
        kind: {
          type: "string",
          const: "all",
          description: "Inspect all canonical record kinds for this discovery frontier.",
        },
      },
      required: ["kind"],
    },
  };
}

function remainingRequiredLedgerKinds(
  requiredKinds: ReadonlySet<LedgerRecordKind>,
  observedKinds: ReadonlySet<LedgerRecordKind>,
): LedgerRecordKind[] {
  return LEDGER_RECORD_DEPENDENCY_ORDER.filter((kind) =>
    requiredKinds.has(kind) && !observedKinds.has(kind),
  );
}

function ledgerCreationTool(
  tool: FunctionToolDefinition,
  remainingKinds: readonly LedgerRecordKind[],
): FunctionToolDefinition {
  if (tool.name !== "project_ledger_create" || remainingKinds.length === 0) return tool;
  const parameters = recordValue(tool.parameters);
  const properties = recordValue(parameters.properties);
  const { status: _runtimeOwnedInitialStatus, ...modelProperties } = properties;
  const required = Array.isArray(parameters.required)
    ? parameters.required.filter((value): value is string => typeof value === "string")
    : [];
  return {
    ...tool,
    description: [
      tool.description,
      `The current typed frontier accepts the remaining dependency chain in this order: ${remainingKinds.join(" -> ")}.`,
      "One work block may batch that ordered chain and multiple task records. Choose stable record ids in the calls, and let later calls in the same block reference the earlier chosen spec or work id; execution preserves call order. Omit status; Project Ledger owns each valid initial lifecycle state.",
    ].join(" "),
    parameters: {
      ...parameters,
      properties: modelProperties,
      required,
      oneOf: remainingKinds.map((kind) => ({
        title: `Create ${kind}`,
        properties: {
          kind: { type: "string", const: kind },
        },
        required: kind === "task"
          ? ["work_id", "spec", "acceptance"]
          : kind === "work"
          ? ["spec", "acceptance"]
          : ["body"],
      })),
    },
  };
}

function isLedgerOnlyTool(name: string): boolean {
  return name.startsWith("project_ledger_") || LEGACY_LEDGER_TOOLS.has(name);
}

function isWorkspaceMutation(name: string, args: Record<string, unknown>): boolean {
  return !isLedgerOnlyTool(name) && name !== "update_todo_list" &&
    !isInternalProgressTool(name) && isStateMutatingToolCall(name, args);
}

function ledgerRecordKindForMutation(
  name: string,
  args: Record<string, unknown>,
): LedgerRecordKind | null {
  if (name === "project_ledger_task_update" || name === "project_ledger_task_complete") return "task";
  if (name === "project_ledger_work_update" || name === "project_ledger_work_complete") return "work";
  if (name !== "project_ledger_create" && name !== "project_ledger_update") return null;
  const kind = args.kind;
  return kind === "spec" || kind === "work" || kind === "task" ? kind : null;
}

function successful(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return true;
  return (value as Record<string, unknown>).ok !== false;
}

function validationReceiptState(value: unknown): "passed" | "failed" | null {
  for (const receipt of evidenceCapabilityReceipts(value)) {
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) continue;
    const record = receipt as Record<string, unknown>;
    if (record.capability !== "validation_passed") continue;
    return record.verified === true && record.maturity === "verified" ? "passed" : "failed";
  }
  return null;
}

function workspaceMutationVerified(name: string, value: unknown): boolean {
  if (name === "write_file") return true;
  return evidenceCapabilityReceipts(value).some((receipt) => {
    const record = recordValue(receipt);
    return record.verified === true && record.maturity === "verified" &&
      (record.capability === "workspace_mutated" || record.capability === "durable_artifact");
  });
}

function evidenceCapabilityReceipts(value: unknown): unknown[] {
  const root = recordValue(value);
  return [root.evidence_capability_receipts, root.evidenceCapabilityReceipts]
    .flatMap((candidate) => Array.isArray(candidate) ? candidate : []);
}

function projectLedgerListCandidateCount(value: unknown): number {
  const root = recordValue(value);
  const data = recordValue(root.data);
  const candidates = Array.isArray(data.results)
    ? data.results
    : Array.isArray(data.records)
    ? data.records
    : [];
  return candidates.length;
}

function planUpdateChangedState(value: unknown): boolean {
  const root = recordValue(value);
  return root.replayed !== true && root.ignored !== true;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 0;
}
