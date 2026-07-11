import type { FunctionToolDefinition } from "../../../../integrations/providers/provider.ts";
import type { CompiledTurnContract } from "../../turn-contract-types.ts";
import { isStateMutatingToolCall } from "../../tool-loop-guards.ts";
import { isInternalProgressTool } from "../progress/runtime-semantic-progress.ts";
import { isStatusReportEvidenceTool } from "./turn-contract-status-evidence.ts";
import {
  explicitPlanArguments,
  requireExplicitPlanUpdate,
} from "./turn-contract-plan-admission.ts";

type LedgerRecordKind = "spec" | "work" | "task";
export type ObligationToolSurfaceStage =
  | "open"
  | "work_planning"
  | "ledger"
  | "workspace_execution"
  | "workspace_validation"
  | "workspace_repair"
  | "status_inspection"
  | "closeout";

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
  validationObserved?: boolean;
  validationFailed?: boolean;
  validationFocused?: boolean;
  statusObserved?: boolean;
  statusFocused?: boolean;
}

export interface ObligationToolSurfaceController {
  project(tools: readonly FunctionToolDefinition[]): FunctionToolDefinition[];
  observe(input: {
    name: string;
    args: Record<string, unknown>;
    result: unknown;
  }): void;
  focusMissingDeliverables(deliverables: readonly string[]): void;
  state(): ObligationToolSurfaceState;
}

export interface ObligationToolSurfaceSession {
  controllerFor(
    contract: CompiledTurnContract | null | undefined,
    seed?: ObligationToolSurfaceSeed,
  ): ObligationToolSurfaceController;
  focusMissingDeliverables(deliverables: readonly string[]): void;
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
    contract && ["start_work", "resume_work", "modify_work"].includes(contract.action),
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
    observe(input) {
      const validation = validationReceiptState(input.result);
      if (validation === "passed") {
        validationObserved = true;
        validationFailed = false;
        validationFocused = false;
      } else if (validation === "failed") {
        validationFailed = true;
      }
      if (successful(input.result) && isStatusReportEvidenceTool(input.name)) {
        statusObserved = true;
      }
      if (
        successful(input.result) &&
        input.name === "update_todo_list" &&
        explicitPlanArguments(input.args)
      ) {
        planReady = true;
      }
      if (!managed) return;
      if (!successful(input.result)) return;
      if (input.name === "project_ledger_list") {
        ledgerDiscoveryObserved = true;
        ledgerDiscoveryCandidateCount = projectLedgerListCandidateCount(input.result);
      }
      const kind = ledgerRecordKindForMutation(input.name, input.args);
      if (kind) {
        ledgerDiscoveryObserved = true;
        observedLedgerKinds.add(kind);
        mutationSequence += 1;
      }
      if (input.name === "project_ledger_check") {
        checkedMutationSequence = mutationSequence;
      }
      if (isWorkspaceMutation(input.name, input.args)) {
        workspaceMutationObserved = true;
        if (validationFailed) validationFailed = false;
      }
    },
    focusMissingDeliverables(deliverables) {
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
      validationObserved,
      validationFailed,
      validationFocused,
      statusObserved,
      statusFocused,
      stage: stage(),
    }),
  };
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
  const root = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const receipts = [root.evidence_capability_receipts, root.evidenceCapabilityReceipts]
    .flatMap((candidate) => Array.isArray(candidate) ? candidate : []);
  for (const receipt of receipts) {
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) continue;
    const record = receipt as Record<string, unknown>;
    if (record.capability !== "validation_passed") continue;
    return record.verified === true && record.maturity === "verified" ? "passed" : "failed";
  }
  return null;
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

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
