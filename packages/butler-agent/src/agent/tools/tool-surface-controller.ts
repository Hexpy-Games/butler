import {
  type ToolSurfaceControllerContext,
  type ToolSurfaceControllerInput,
  type ToolSurfaceControllerState,
  type ToolSurfaceControllerStatus,
  type ToolSurfaceDiscoveryAction,
  type ToolSurfaceProviderCapabilities,
  type ToolSurfaceToolName,
  type ToolSurfaceTransitionEvent,
} from "./tool-surface-types.ts";
import {
  assertNoNaturalLanguageInputFields,
  cloneConfiguredCapabilities,
  cloneProviderCapabilities,
  cloneStructuredMetadata,
  cloneUserApprovals,
  mergeToolNames,
  normalizedDisabledReasons,
  ToolSurfaceStructuredInputError,
} from "./tool-surface-validation.ts";

export {
  TOOL_SURFACE_CONTROLLER_STATES,
  type ToolSurfaceConfiguredCapabilities,
  type ToolSurfaceControllerContext,
  type ToolSurfaceControllerInput,
  type ToolSurfaceControllerState,
  type ToolSurfaceControllerStatus,
  type ToolSurfaceDescription,
  type ToolSurfaceDiscovery,
  type ToolSurfaceDiscoveryAction,
  type ToolSurfaceMetadata,
  type ToolSurfacePhasePolicy,
  type ToolSurfacePromotion,
  type ToolSurfaceProviderCapabilities,
  type ToolSurfaceSessionMode,
  type ToolSurfaceToolName,
  type ToolSurfaceTransitionEvent,
  type ToolSurfaceUserApproval,
} from "./tool-surface-types.ts";

type InitialState = Extract<ToolSurfaceControllerState, { status: "initial" }>;
type DiscoveredState = Extract<ToolSurfaceControllerState, { status: "discovered" }>;
type DescribedState = Extract<ToolSurfaceControllerState, { status: "described" }>;
type PromotedState = Extract<ToolSurfaceControllerState, { status: "promoted" }>;
type DeniedState = Extract<ToolSurfaceControllerState, { status: "denied" }>;
type DisabledState = Extract<ToolSurfaceControllerState, { status: "disabled" }>;

export class ToolSurfaceControllerInputError extends Error {
  override name = "ToolSurfaceControllerInputError";
}

export class ToolSurfaceTransitionError extends Error {
  override name = "ToolSurfaceTransitionError";
}

const ALLOWED_TRANSITIONS: Record<ToolSurfaceControllerStatus, readonly ToolSurfaceTransitionEvent["type"][]> = {
  initial: ["discover", "disable"],
  discovered: ["describe", "deny", "disable"],
  described: ["promote", "deny", "disable"],
  promoted: ["invoke", "deny", "disable"],
  invoked: [],
  denied: [],
  disabled: [],
};

function rejectNaturalLanguageInputFields(value: unknown, surface: string): void {
  try {
    assertNoNaturalLanguageInputFields(value, surface);
  } catch (error) {
    if (error instanceof ToolSurfaceStructuredInputError) {
      throw new ToolSurfaceControllerInputError(error.message);
    }
    throw error;
  }
}

function createContext(input: ToolSurfaceControllerInput): ToolSurfaceControllerContext {
  rejectNaturalLanguageInputFields(input, "ToolSurfaceControllerInput");
  if (!input.role.trim()) {
    throw new ToolSurfaceControllerInputError("ToolSurfaceControllerInput.role must be a non-empty string");
  }
  return {
    role: input.role.trim(),
    sessionMode: input.sessionMode,
    configuredCapabilities: cloneConfiguredCapabilities(input.configuredCapabilities),
    userApprovals: cloneUserApprovals(input.userApprovals),
    projectMetadata: cloneStructuredMetadata(input.projectMetadata, "ToolSurfaceProjectMetadata"),
    sessionMetadata: cloneStructuredMetadata(input.sessionMetadata, "ToolSurfaceSessionMetadata"),
    turnMetadata: cloneStructuredMetadata(input.turnMetadata, "ToolSurfaceTurnMetadata"),
    requiredNativeTools: mergeToolNames(input.requiredNativeTools),
    providerCapabilities: cloneProviderCapabilities(input.providerCapabilities),
    disabledReasons: normalizedDisabledReasons(input),
    discoveryActions: [...(input.discoveryActions ?? [])],
  };
}

function mergedDiscoveryActions(
  context: ToolSurfaceControllerContext,
  eventActions: readonly ToolSurfaceDiscoveryAction[] | undefined,
): ToolSurfaceDiscoveryAction[] {
  return [...context.discoveryActions, ...(eventActions ?? [])];
}

function toolNamesFromDiscoveryActions(actions: readonly ToolSurfaceDiscoveryAction[]): ToolSurfaceToolName[] {
  return actions.flatMap((action) => action.type === "require-tool" ? [action.toolName] : []);
}

function assertToolWasPromoted(state: PromotedState, toolName: ToolSurfaceToolName): ToolSurfaceToolName {
  const normalizedToolName = toolName.trim();
  if (!normalizedToolName) {
    throw new ToolSurfaceTransitionError("invoke transition requires a non-empty toolName");
  }
  if (!state.promotion.enabledToolNames.includes(normalizedToolName)) {
    throw new ToolSurfaceTransitionError(`invoke transition requires a described and promoted tool: ${normalizedToolName}`);
  }
  return normalizedToolName;
}

function transitionDenied(state: ToolSurfaceControllerState, reason: string): DeniedState {
  if (!reason.trim()) {
    throw new ToolSurfaceTransitionError("deny transition requires a non-empty reason");
  }
  return {
    status: "denied",
    context: state.context,
    deniedReason: reason.trim(),
  };
}

function transitionDisabled(
  state: ToolSurfaceControllerState,
  reasons: readonly string[],
  providerCapabilities?: ToolSurfaceProviderCapabilities,
): DisabledState {
  const disabledReasons = normalizedDisabledReasons({
    providerCapabilities: providerCapabilities ?? state.context.providerCapabilities,
    disabledReasons: reasons,
  });
  if (disabledReasons.length === 0) {
    throw new ToolSurfaceTransitionError("disable transition requires a non-empty reason");
  }
  return {
    status: "disabled",
    context: {
      ...state.context,
      providerCapabilities: cloneProviderCapabilities(providerCapabilities ?? state.context.providerCapabilities),
      disabledReasons,
    },
    disabledReasons,
  };
}

export function createInitialToolSurfaceControllerState(
  input: ToolSurfaceControllerInput,
): InitialState {
  return {
    status: "initial",
    context: createContext(input),
  };
}

export function isToolSurfaceTransitionAllowed(
  state: Pick<ToolSurfaceControllerState, "status">,
  type: ToolSurfaceTransitionEvent["type"],
): boolean {
  return (ALLOWED_TRANSITIONS[state.status] as readonly string[]).includes(type);
}

export function transitionToolSurfaceControllerState(
  state: ToolSurfaceControllerState,
  event: ToolSurfaceTransitionEvent,
): ToolSurfaceControllerState {
  rejectNaturalLanguageInputFields(event, "ToolSurfaceTransitionEvent");
  if (!isToolSurfaceTransitionAllowed(state, event.type)) {
    throw new ToolSurfaceTransitionError(`invalid tool surface transition: ${state.status} -> ${event.type}`);
  }

  switch (event.type) {
    case "discover": {
      const discoveryActions = mergedDiscoveryActions(state.context, event.discoveryActions);
      const discovery = {
        actions: discoveryActions,
        discoveredToolNames: mergeToolNames(
          event.requiredNativeTools,
          toolNamesFromDiscoveryActions(discoveryActions),
        ),
      };
      return {
        status: "discovered",
        context: state.context,
        discovery,
      };
    }
    case "describe": {
      const discovered = state as DiscoveredState;
      const description = {
        describedToolNames: mergeToolNames(event.requiredNativeTools),
      };
      return {
        status: "described",
        context: discovered.context,
        discovery: discovered.discovery,
        description,
      };
    }
    case "promote": {
      const described = state as DescribedState;
      const disabledReasons = normalizedDisabledReasons({
        providerCapabilities: event.providerCapabilities ?? described.context.providerCapabilities,
        disabledReason: event.disabledReason,
        disabledReasons: [
          ...described.context.disabledReasons,
          ...(event.disabledReasons ?? []),
        ],
      });
      if (disabledReasons.length > 0) {
        return transitionDisabled(described, disabledReasons, event.providerCapabilities);
      }
      return {
        status: "promoted",
        context: {
          ...described.context,
          providerCapabilities: cloneProviderCapabilities(event.providerCapabilities ?? described.context.providerCapabilities),
        },
        discovery: described.discovery,
        description: described.description,
        promotion: {
          providerCapabilities: cloneProviderCapabilities(event.providerCapabilities ?? described.context.providerCapabilities),
          enabledToolNames: [...described.description.describedToolNames],
        },
      };
    }
    case "invoke": {
      const promoted = state as PromotedState;
      const toolName = assertToolWasPromoted(promoted, event.toolName);
      return {
        status: "invoked",
        context: promoted.context,
        discovery: promoted.discovery,
        description: promoted.description,
        promotion: promoted.promotion,
        invocation: {
          toolName,
        },
      };
    }
    case "deny":
      return transitionDenied(state, event.reason);
    case "disable":
      return transitionDisabled(state, [event.reason], event.providerCapabilities);
  }
}
