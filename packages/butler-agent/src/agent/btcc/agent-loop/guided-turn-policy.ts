import type { ButlerExecutionPolicy } from "../contracts.ts";
import type { BtccAgentLoopResult } from "./contracts.ts";
import type { TurnRecord } from "../turn/index.ts";
import { parseToolCatalogId } from "../../tools/progressive-catalog.ts";
import { BUTLER_TOOLS } from "../../tools/butler-tools.ts";
import type { WorkspaceReference } from "../../session-workspaces/index.ts";
import { isM1MinimalToolSurfaceEnabled } from
  "../../tools/m1-minimal-tool-surface.ts";
import { PROJECT_LEDGER_MUTATION_TOOL_NAME_SET } from
  "../../tools/project-ledger/mutation-tools.ts";
import { WORK_TRACKING_TOOL_NAMES } from "../../tools/work-tracking/shared.ts";
import { selectInitialToolsFromSurfaceController } from
  "../../tools/tool-surface-selection.ts";
import type {
  ButlerToolDefinition,
  NativeToolAvailabilityOverrides,
} from "../../tools/types.ts";
import { isDurableWorkTool } from "../work/index.ts";
import { GUIDED_PROJECT_LEDGER_EFFECT_TOOL_NAMES } from
  "./guided-project-ledger-effect.ts";
import { guidedToolDefinition } from "./guided-tool-definition.ts";
import { safeCommandActionLabel } from "../../output/progress/arguments.ts";
import { currentModelRouteCandidate } from "../model-route/index.ts";
import {
  finalizeGuidedToolSurface,
  prepareGuidedToolSurfaceBoundary,
  type GuidedToolSurface,
} from "./guided-tool-surface.ts";

const GUIDED_AUTOMATION_EFFECT_UNAVAILABLE = {
  disabledReason:
    "This guided runtime does not yet have a typed automation effect adapter. Automation changes are unavailable; read-only automation listing remains available.",
  recoveryHint:
    "Use list_automations for read-only inspection, or report that creating, deleting, and running automations is unavailable in this runtime.",
} as const;

export const GUIDED_NATIVE_TOOL_AVAILABILITY_OVERRIDES = {
  create_automation: GUIDED_AUTOMATION_EFFECT_UNAVAILABLE,
  delete_automation: GUIDED_AUTOMATION_EFFECT_UNAVAILABLE,
  run_due_automations: GUIDED_AUTOMATION_EFFECT_UNAVAILABLE,
  call_mcp_tool: {
    disabledReason:
      "This guided runtime does not yet have a guarded MCP effect adapter. MCP tool dispatch is unavailable; MCP capability discovery and resource reads remain available.",
    recoveryHint:
      "Use list_mcp_capabilities or read_mcp_resource for read-only evidence, choose an enabled native tool, or report the limitation.",
  },
} as const satisfies NativeToolAvailabilityOverrides;

export const GUIDED_UNAVAILABLE_NATIVE_TOOL_NAMES = new Set(
  Object.keys(GUIDED_NATIVE_TOOL_AVAILABILITY_OVERRIDES),
);

export function guidedPolicy(turn: TurnRecord): ButlerExecutionPolicy {
  if (turn.context.executionPolicy) {
    return {
      ...turn.context.executionPolicy,
      ...(turn.context.projectRef && !turn.context.executionPolicy.projectId
        ? { projectId: turn.context.projectRef }
        : {}),
      accessMode: narrowerAccessMode(
        turn.context.executionPolicy.accessMode,
        admittedAccessMode(turn),
      ),
    };
  }
  return {
    role: "butler",
    accessMode: admittedAccessMode(turn),
    trackingMode: turn.context.projectRef ? "ledger" : "local",
    requiredNativeToolProfiles: [],
    requiredNativeTools: [],
    workspacePath: workspaceFromScopes(turn) ?? process.cwd(),
    ...(turn.context.projectRef ? { projectId: turn.context.projectRef } : {}),
  };
}

export function selectGuidedToolSurface(
  turn: TurnRecord,
  env: NodeJS.ProcessEnv = process.env,
  workspaceReference?: WorkspaceReference,
): GuidedToolSurface {
  const policy = guidedPolicy(turn);
  const boundary = prepareGuidedToolSurfaceBoundary(turn, policy);
  // The feature flag is read exactly once at the named policy boundary.
  const minimal = isM1MinimalToolSurfaceEnabled(env);
  const selected = selectInitialToolsFromSurfaceController({
    role: policy.role,
    ...(minimal
      ? {
          phasePolicy: boundary.minimalPhasePolicy,
          workspaceReference: requiredWorkspaceReference(workspaceReference),
        }
      : { message: turn.originalMessage }),
    sessionMetadata: {
      ...(policy.projectId ? { projectId: policy.projectId } : {}),
      runtimePolicy: boundary.runtimePolicy,
    },
    tools: BUTLER_TOOLS,
  }).tools;
  return finalizeGuidedToolSurface({
    env,
    guidedLedgerEffects: boundary.guidedLedgerEffects,
    minimal,
    policy,
    selected,
    turn,
    unavailableToolNames: GUIDED_UNAVAILABLE_NATIVE_TOOL_NAMES,
  });
}

function requiredWorkspaceReference(
  reference: WorkspaceReference | undefined,
): WorkspaceReference {
  if (reference) return reference;
  throw new Error("m1_minimal_tool_surface_workspace_reference_required");
}

export function hiddenNativeToolNamesForGuidedTurn(
  enableProjectLedgerEffects: boolean,
): string[] {
  const supported = new Set<string>(
    enableProjectLedgerEffects ? GUIDED_PROJECT_LEDGER_EFFECT_TOOL_NAMES : [],
  );
  return [
    ...WORK_TRACKING_TOOL_NAMES,
    ...[...PROJECT_LEDGER_MUTATION_TOOL_NAME_SET]
      .filter((name) => !supported.has(name)),
  ];
}

export function guidedNativeToolDefinitions(): ButlerToolDefinition[] {
  return BUTLER_TOOLS.map(guidedToolDefinition);
}

export function selectedModelRef(turn: TurnRecord): string {
  const routed = turn.modelRoute && currentModelRouteCandidate(turn.modelRoute)?.modelRef;
  if (routed) return routed;
  return turn.modelSelection.model.includes("/")
    ? turn.modelSelection.model
    : `${turn.modelSelection.provider}/${turn.modelSelection.model}`;
}

export function effectiveToolNameForCall(
  name: string,
  args: Record<string, unknown>,
): string {
  if (name !== "tool_call") return name;
  const id = typeof args.id === "string" ? args.id : "";
  return parseToolCatalogId(id)?.name || name;
}

export function invalidRunCommandSummary(input: {
  callName: string;
  callArgs: Record<string, unknown>;
  effectiveToolName: string;
  presentationArgs: Record<string, unknown>;
}): Record<string, unknown> | null {
  const directRunCommand = input.callName === "run_command" &&
    input.effectiveToolName === "run_command";
  const catalogId = typeof input.callArgs.id === "string"
    ? parseToolCatalogId(input.callArgs.id)
    : null;
  const progressiveRunCommand = input.callName === "tool_call" &&
    input.effectiveToolName === "run_command" &&
    catalogId?.provider === "native" &&
    catalogId.namespace === null &&
    catalogId.name === "run_command";
  if (!directRunCommand && !progressiveRunCommand) return null;
  if (safeCommandActionLabel(input.presentationArgs)) return null;
  return {
    ok: false,
    error: {
      code: "invalid_tool_arguments",
      message: "Tool run_command requires a one-line action label in summary (max 32 characters)",
      path: "$.summary",
    },
  };
}

export function routeForUsedTools(
  tools: readonly string[],
  hasBoundWork = false,
): BtccAgentLoopResult["route"] {
  if (hasBoundWork) return "managed";
  if (tools.length === 0) return "direct";
  return "assisted";
}

export function isReplaySafeTool(name: string): boolean {
  if (isDurableWorkTool(name)) return true;
  const nativeTool = BUTLER_TOOLS.find((tool) => tool.name === name);
  if (nativeTool?.effectBoundary === "none") return true;
  if (name === "bind_session_git_worktree" || name === "write_file" || name === "edit_file" || name === "run_command" ||
      GUIDED_PROJECT_LEDGER_EFFECT_TOOL_NAMES.includes(
        name as typeof GUIDED_PROJECT_LEDGER_EFFECT_TOOL_NAMES[number],
      )) return true;
  return false;
}

export function priorToolFailure(
  status: "failed" | "cancelled",
  toolName: string,
): Record<string, unknown> {
  return {
    ok: false,
    error: {
      code: status === "cancelled" ? "prior_tool_call_cancelled" : "prior_tool_call_failed",
      message: `The previous ${toolName} call did not complete successfully. Adjust the call or continue with other evidence.`,
    },
  };
}

export function uncertainPriorMutation(toolName: string): Record<string, unknown> {
  return {
    ok: false,
    error: {
      code: "prior_mutation_completion_unknown",
      message: `A previous ${toolName} call may have changed external state, but its result was not durably recorded. Inspect the target before deciding whether another mutation is safe.`,
    },
  };
}

function admittedAccessMode(turn: TurnRecord): ButlerExecutionPolicy["accessMode"] {
  const value = turn.modelSelection.controls.accessMode;
  if (value === "full_access" || value === "ask_first" || value === "read_only") return value;
  return "read_only";
}

function narrowerAccessMode(
  context: ButlerExecutionPolicy["accessMode"],
  admitted: ButlerExecutionPolicy["accessMode"],
): ButlerExecutionPolicy["accessMode"] {
  const rank = { read_only: 0, ask_first: 1, full_access: 2 } as const;
  return rank[context] <= rank[admitted] ? context : admitted;
}

function workspaceFromScopes(turn: TurnRecord): string | null {
  const scope = turn.context.baselineObservationScopeRefs.find((ref) => ref.startsWith("workspace:"));
  return scope ? scope.slice("workspace:".length) : null;
}
