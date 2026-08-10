export const TOOL_SURFACE_CONTROLLER_STATES = [
  "initial",
  "discovered",
  "described",
  "promoted",
  "invoked",
  "denied",
  "disabled",
] as const;

export type ToolSurfaceControllerStatus = typeof TOOL_SURFACE_CONTROLLER_STATES[number];

export type ToolSurfaceMetadata = Readonly<Record<string, unknown>>;

export type ToolSurfaceToolName = string;

export type ToolSurfaceSessionMode = "interactive" | "worker" | "automation" | "background";

/**
 * The immutable authority snapshot used for a phase-boundary selection.
 *
 * This deliberately contains policy facts only. It has no prompt, message,
 * semantic label, or workspace path; the live WorkspaceReference is carried
 * separately by the selection input.
 */
export interface ToolSurfacePhasePolicy {
  readonly phaseId: string;
  readonly policyRevision: string;
  readonly role: string;
  readonly accessMode: "full_access" | "ask_first" | "read_only";
  readonly trackingMode: "ledger" | "local" | "none";
  readonly requiredNativeToolProfiles: readonly string[];
  readonly requiredNativeTools: readonly ToolSurfaceToolName[];
  readonly toolSurfaceMode: "fixed";
  readonly projectId?: string;
}

export type ToolSurfaceProviderCapabilities = Readonly<Record<string, unknown>> & {
  supportsToolCalls?: boolean;
  supportsStreaming?: boolean;
};

export interface ToolSurfaceConfiguredCapabilities {
  toolNames?: readonly ToolSurfaceToolName[];
  allowFilesystem?: boolean;
  allowPublicWeb?: boolean;
  allowDelegation?: boolean;
  allowMcp?: boolean;
}

export interface ToolSurfaceUserApproval {
  target:
    | Readonly<{ type: "capability"; name: string }>
    | Readonly<{ type: "tool"; toolName: ToolSurfaceToolName }>;
  approved: boolean;
  reason?: string;
}

export type ToolSurfaceDiscoveryAction =
  | Readonly<{ type: "require-tool"; toolName: ToolSurfaceToolName; source?: "model" | "policy" }>
  | Readonly<{ type: "skip-tool-surface"; reason: string; source?: "model" | "policy" }>;

export interface ToolSurfaceControllerInput {
  role: string;
  sessionMode: ToolSurfaceSessionMode;
  configuredCapabilities?: ToolSurfaceConfiguredCapabilities;
  userApprovals?: readonly ToolSurfaceUserApproval[];
  projectMetadata?: ToolSurfaceMetadata;
  sessionMetadata?: ToolSurfaceMetadata;
  turnMetadata?: ToolSurfaceMetadata;
  requiredNativeTools?: readonly ToolSurfaceToolName[];
  providerCapabilities?: ToolSurfaceProviderCapabilities;
  disabledReason?: string;
  disabledReasons?: readonly string[];
  discoveryActions?: readonly ToolSurfaceDiscoveryAction[];
}

export interface ToolSurfaceControllerContext {
  role: string;
  sessionMode: ToolSurfaceSessionMode;
  configuredCapabilities?: ToolSurfaceConfiguredCapabilities;
  userApprovals: readonly ToolSurfaceUserApproval[];
  projectMetadata?: ToolSurfaceMetadata;
  sessionMetadata?: ToolSurfaceMetadata;
  turnMetadata?: ToolSurfaceMetadata;
  requiredNativeTools: readonly ToolSurfaceToolName[];
  providerCapabilities?: ToolSurfaceProviderCapabilities;
  disabledReasons: readonly string[];
  discoveryActions: readonly ToolSurfaceDiscoveryAction[];
}

export interface ToolSurfaceDiscovery {
  actions: readonly ToolSurfaceDiscoveryAction[];
  discoveredToolNames: readonly ToolSurfaceToolName[];
}

export interface ToolSurfaceDescription {
  describedToolNames: readonly ToolSurfaceToolName[];
}

export interface ToolSurfacePromotion {
  providerCapabilities?: ToolSurfaceProviderCapabilities;
  enabledToolNames: readonly ToolSurfaceToolName[];
}

export type ToolSurfaceControllerState =
  | Readonly<{ status: "initial"; context: ToolSurfaceControllerContext }>
  | Readonly<{ status: "discovered"; context: ToolSurfaceControllerContext; discovery: ToolSurfaceDiscovery }>
  | Readonly<{ status: "described"; context: ToolSurfaceControllerContext; discovery: ToolSurfaceDiscovery; description: ToolSurfaceDescription }>
  | Readonly<{ status: "promoted"; context: ToolSurfaceControllerContext; discovery: ToolSurfaceDiscovery; description: ToolSurfaceDescription; promotion: ToolSurfacePromotion }>
  | Readonly<{ status: "invoked"; context: ToolSurfaceControllerContext; discovery: ToolSurfaceDiscovery; description: ToolSurfaceDescription; promotion: ToolSurfacePromotion; invocation: { toolName: string } }>
  | Readonly<{ status: "denied"; context: ToolSurfaceControllerContext; deniedReason: string }>
  | Readonly<{ status: "disabled"; context: ToolSurfaceControllerContext; disabledReasons: readonly string[] }>;

export type ToolSurfaceTransitionEvent =
  | Readonly<{
    type: "discover";
    discoveryActions?: readonly ToolSurfaceDiscoveryAction[];
    requiredNativeTools?: readonly ToolSurfaceToolName[];
  }>
  | Readonly<{
    type: "describe";
    requiredNativeTools?: readonly ToolSurfaceToolName[];
  }>
  | Readonly<{
    type: "promote";
    providerCapabilities?: ToolSurfaceProviderCapabilities;
    disabledReason?: string;
    disabledReasons?: readonly string[];
  }>
  | Readonly<{ type: "invoke"; toolName: string }>
  | Readonly<{ type: "deny"; reason: string }>
  | Readonly<{ type: "disable"; reason: string; providerCapabilities?: ToolSurfaceProviderCapabilities }>;
