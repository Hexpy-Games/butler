import type { FunctionToolDefinition } from "../../integrations/providers/provider.ts";
import { BUTLER_TOOLS } from "./butler-tools.ts";
import {
  createInitialToolSurfaceControllerState,
  type ToolSurfaceControllerInput,
  type ToolSurfaceProviderCapabilities,
} from "./tool-surface-controller.ts";
import { selectButlerToolsForTurn } from "./profiles.ts";
import { mergeToolNames } from "./tool-surface-validation.ts";

type InitialState = ReturnType<typeof createInitialToolSurfaceControllerState>;

export interface InitialToolSurfaceSelectionInput {
  role: string;
  message?: string;
  sessionMetadata?: Record<string, unknown>;
  turnMetadata?: Record<string, unknown>;
  providerCapabilities?: Readonly<{
    supportsToolCalls?: boolean;
    supportsStreaming?: boolean;
  }>;
  tools?: readonly FunctionToolDefinition[];
}

export interface InitialToolSurfaceSelection {
  state: InitialState;
  tools: FunctionToolDefinition[];
  toolNames: string[];
}

export function selectInitialToolsFromSurfaceController(
  input: InitialToolSurfaceSelectionInput,
): InitialToolSurfaceSelection {
  const state = createInitialToolSurfaceControllerState({
    role: input.role,
    sessionMode: sessionModeFromRole(input.role),
    sessionMetadata: surfacePolicyMetadata(input.sessionMetadata),
    turnMetadata: surfacePolicyMetadata(input.turnMetadata),
    providerCapabilities: surfaceProviderCapabilities(input.providerCapabilities),
    requiredNativeTools: requiredNativeToolsFromRuntimePolicy([
      input.sessionMetadata,
      input.turnMetadata,
    ]),
  });
  const tools = selectButlerToolsForTurn({
    role: state.context.role,
    text: input.message,
    sessionMetadata: state.context.sessionMetadata,
    turnMetadata: state.context.turnMetadata,
    tools: input.tools ?? BUTLER_TOOLS,
  });
  return {
    state,
    tools,
    toolNames: tools.map((tool) => tool.name),
  };
}

function sessionModeFromRole(role: string): ToolSurfaceControllerInput["sessionMode"] {
  if (role === "worker") return "worker";
  if (role === "automation") return "automation";
  return "interactive";
}

function requiredNativeToolsFromRuntimePolicy(
  metadataSources: readonly (Record<string, unknown> | undefined)[],
): string[] {
  return mergeToolNames(metadataSources.flatMap((metadata) =>
    policyStringArray(metadata, "requiredNativeTools", "required_tools"),
  ));
}

function surfacePolicyMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const record = objectRecord(metadata);
  const runtimePolicy = objectRecord(record.runtimePolicy);
  const filtered = pickDefined({
    projectId: record.projectId,
    project_id: record.project_id,
    projectPath: record.projectPath,
    project_path: record.project_path,
    requiredNativeTools: record.requiredNativeTools,
    required_tools: record.required_tools,
    requiredNativeToolProfiles: record.requiredNativeToolProfiles,
    required_tool_profiles: record.required_tool_profiles,
    runtimePolicy: surfaceRuntimePolicy(runtimePolicy),
  });
  return Object.keys(filtered).length > 0 ? filtered : undefined;
}

function surfaceRuntimePolicy(runtimePolicy: Record<string, unknown>): Record<string, unknown> | undefined {
  const filtered = pickDefined({
    projectId: runtimePolicy.projectId,
    project_id: runtimePolicy.project_id,
    projectPath: runtimePolicy.projectPath,
    project_path: runtimePolicy.project_path,
    requiredNativeTools: runtimePolicy.requiredNativeTools,
    required_tools: runtimePolicy.required_tools,
    requiredNativeToolProfiles: runtimePolicy.requiredNativeToolProfiles,
    required_tool_profiles: runtimePolicy.required_tool_profiles,
  });
  return Object.keys(filtered).length > 0 ? filtered : undefined;
}

function surfaceProviderCapabilities(
  capabilities: InitialToolSurfaceSelectionInput["providerCapabilities"] | undefined,
): ToolSurfaceProviderCapabilities | undefined {
  if (capabilities === undefined) return undefined;
  return pickDefined({
    supportsToolCalls: capabilities.supportsToolCalls,
    supportsStreaming: capabilities.supportsStreaming,
  }) as ToolSurfaceProviderCapabilities;
}

function pickDefined(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function policyStringArray(
  metadata: Record<string, unknown> | undefined,
  camelKey: string,
  snakeKey: string,
): string[] {
  const record = objectRecord(metadata);
  const runtimePolicy = objectRecord(record.runtimePolicy);
  const value = record[camelKey] ?? record[snakeKey] ?? runtimePolicy[camelKey] ?? runtimePolicy[snakeKey];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
