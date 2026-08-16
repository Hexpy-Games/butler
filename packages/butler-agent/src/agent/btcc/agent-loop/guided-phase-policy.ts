import type { ButlerExecutionPolicy } from "../contracts.ts";
import type { TurnRecord } from "../turn/index.ts";
import type { FunctionToolDefinition } from
  "../../../integrations/providers/runtime-contracts.ts";
import { BUTLER_TOOLS } from "../../tools/butler-tools.ts";
import { TOOL_CAPABILITY_METADATA } from "../../tools/registry.ts";
import {
  diagnoseButlerToolPolicy,
  selectButlerToolsForProfiles,
} from "../../tools/profiles.ts";
import { DURABLE_WORK_TOOL_DEFINITIONS } from "./durable-work-tools.ts";
import { GUIDED_PROJECT_LEDGER_EFFECT_TOOL_NAMES } from
  "./guided-project-ledger-effect.ts";
import { guidedToolDefinition } from "./guided-tool-definition.ts";
import { guidedInstructions } from "./guided-turn-prompt.ts";
import {
  authorizedToolDefinitions,
  GUIDED_NATIVE_TOOL_AVAILABILITY_OVERRIDES,
  guidedPolicy,
  visibleToolDefinitions,
} from "./guided-turn-policy.ts";
import {
  admitExactResultReadTool,
  isExactResultReadTool,
  selectExactResultReplayPhase,
  type ExactResultReplayPhaseSelection,
} from "../operation-result-replay/index.ts";
import { phaseMinimalStableInstructionSurface } from "./guided-phase-instructions.ts";

const FLAG_NAME = "BUTLER_PHASE_TOOL_SURFACE";
const POLICY_REVISION = "butler.btcc-tool-instruction-policy.v1";
const TRUE_FLAG_VALUES = new Set(["1", "true", "on", "yes"]);

export type GuidedTurnPhase = "direct" | "read_only" | "execution";

interface GuidedTurnPhasePolicySelection {
  mode: "legacy" | "phase_minimal";
  phase: GuidedTurnPhase;
  policyRevision: string;
  executionPolicy: ButlerExecutionPolicy;
  authorizedTools: FunctionToolDefinition[];
  providerTools: FunctionToolDefinition[];
  stableInstructionPrefix: string;
  exactResultReplay: ExactResultReplayPhaseSelection;
  stableProviderCachePrefix?: import("../ports/model-round.ts").StableProviderCachePrefixContract;
}

/** Immutable BTCC admission used once by the production guided Turn agent. */
export function selectGuidedTurnPhasePolicy(
  turn: TurnRecord,
  env: Record<string, string | undefined> = process.env,
): GuidedTurnPhasePolicySelection {
  const executionPolicy = guidedPolicy(turn);
  const exactResultReplay = selectExactResultReplayPhase(env);
  const legacyAuthorized = authorizedToolDefinitions(
    turn, env, exactResultReplay.exactReadCapability,
  );
  const legacyProvider = visibleToolDefinitions(legacyAuthorized, executionPolicy);
  const phase = guidedTurnPhase(executionPolicy);
  if (!exactResultReplay.exactReadCapability &&
    executionPolicy.requiredNativeTools.some(isExactResultReadTool)) {
    const requiredExactTool = executionPolicy.requiredNativeTools
      .find(isExactResultReadTool)!;
    throw new Error(
      `required tool is unavailable while exact replay is disabled: ${requiredExactTool}`,
    );
  }
  if (!isEnabled(env)) {
    return {
      mode: "legacy",
      phase,
      policyRevision: "legacy",
      executionPolicy,
      authorizedTools: admitExactResultReadTool(legacyAuthorized, exactResultReplay),
      providerTools: admitExactResultReadTool(legacyProvider, exactResultReplay),
      stableInstructionPrefix: guidedInstructions(executionPolicy),
      exactResultReplay,
    };
  }

  assertRequiredProfilesKnown(executionPolicy.requiredNativeToolProfiles);
  assertNonExecutionProfilesEffectFree(
    executionPolicy.requiredNativeToolProfiles,
    phase,
  );

  const admittedProfileTools = selectButlerToolsForProfiles(
    executionPolicy.requiredNativeToolProfiles,
  ).filter((tool) => !isGuidedRuntimeUnavailable(tool.name))
    .filter((tool) => exactResultReplay.exactReadCapability ||
      !isExactResultReadTool(tool.name));
  const admittedAuthority = new Map([
    ...legacyAuthorized,
    ...admittedProfileTools,
  ].map((tool) => [tool.name, tool]));
  const authorizedTools = admitExactResultReadTool(
    [...admittedAuthority.values()].filter((tool) => phaseAllowsTool(phase, tool)),
    exactResultReplay,
  );
  const admittedRequiredToolNames = new Set([
    ...executionPolicy.requiredNativeTools,
    ...executionPolicy.requiredNativeToolProfiles.flatMap((profile) =>
      profileInitialToolNames(profile, phase),
    ),
  ]);
  assertRequiredToolsRetained(
    executionPolicy.requiredNativeTools,
    authorizedTools,
    phase,
  );
  const providerCandidateNames = providerCandidateToolNames(
    phase,
    authorizedTools,
    admittedRequiredToolNames,
  );
  const providerTools = authorizedTools
    .filter((tool) =>
      providerCandidateNames.has(tool.name) || isExactResultReadTool(tool.name),
    )
    .map(guidedToolDefinition)
    .map(removeRuntimeOwnedSchemaDefaults);
  assertRequiredToolsRetained(
    executionPolicy.requiredNativeTools,
    providerTools,
    phase,
  );
  assertRequiredProfileAuthorityRetained(
    executionPolicy.requiredNativeToolProfiles,
    authorizedTools,
    providerTools,
    phase,
  );
  const stableInstructions = phaseMinimalStableInstructionSurface(
    phase, executionPolicy, POLICY_REVISION,
  );
  return {
    mode: "phase_minimal",
    phase,
    policyRevision: POLICY_REVISION,
    executionPolicy,
    authorizedTools,
    providerTools,
    ...stableInstructions,
    exactResultReplay,
  };
}

function assertRequiredProfilesKnown(requiredProfiles: readonly string[]): void {
  const diagnostics = diagnoseButlerToolPolicy({
    turnMetadata: { requiredNativeToolProfiles: requiredProfiles },
  });
  const [unknown] = diagnostics.unknownRequiredNativeToolProfiles;
  if (unknown) throw new Error(`unknown required tool profile: ${unknown}`);
}

function providerCandidateToolNames(
  phase: GuidedTurnPhase,
  authorizedTools: readonly FunctionToolDefinition[],
  admittedRequiredToolNames: ReadonlySet<string>,
): Set<string> {
  const baselineProfiles = [
    "public-web",
    ...(phase === "direct" ? [] : ["workspace"]),
    ...(authorizedTools.some((tool) =>
        TOOL_CAPABILITY_METADATA[tool.name]?.category === "project",
      )
      ? ["project"]
      : []),
  ];
  const names = new Set([
    ...baselineProfiles.flatMap((profile) =>
      profileInitialToolNames(profile, phase),
    ),
    ...selectButlerToolsForProfiles(["startup"])
      .filter((tool) => {
        const metadata = TOOL_CAPABILITY_METADATA[tool.name];
        return metadata?.category === "memory" &&
          !metadata.tags.includes("context");
      })
      .map((tool) => tool.name),
    ...admittedRequiredToolNames,
  ]);
  for (const tool of authorizedTools) {
    const metadata = TOOL_CAPABILITY_METADATA[tool.name];
    if (metadata?.category === "control" && metadata.tags.includes("bridge")) {
      names.add(tool.name);
    }
  }
  if (phase === "execution") {
    for (const tool of DURABLE_WORK_TOOL_DEFINITIONS) names.add(tool.name);
  }
  return names;
}

function profileInitialToolNames(
  profile: string,
  phase: GuidedTurnPhase,
): string[] {
  if (profile === "project-lifecycle") {
    return [];
  }
  const tools = selectButlerToolsForProfiles([profile])
    .filter((tool) => !isGuidedRuntimeUnavailable(tool.name))
    .filter((tool) => phaseAllowsTool(phase, tool));
  if (profile === "project") {
    const canonicalInspection = tools.find((tool) =>
      BUTLER_TOOLS.find((candidate) => candidate.name === tool.name)
        ?.effectBoundary === "none",
    );
    return canonicalInspection ? [canonicalInspection.name] : [];
  }
  if (profile === "workspace") {
    return tools
      .filter((tool) => {
        const category = TOOL_CAPABILITY_METADATA[tool.name]?.category;
        return category === "command" || category === "file";
      })
      .map((tool) => tool.name);
  }
  return tools.map((tool) => tool.name);
}

function assertRequiredProfileAuthorityRetained(
  profiles: readonly string[],
  authorizedTools: readonly FunctionToolDefinition[],
  providerTools: readonly FunctionToolDefinition[],
  phase: GuidedTurnPhase,
): void {
  const authorizedNames = new Set(authorizedTools.map((tool) => tool.name));
  const retainedNames = new Set(providerTools.map((tool) => tool.name));
  for (const profile of profiles) {
    if (profile === "project-lifecycle") {
      if (
        phase !== "execution" ||
        GUIDED_PROJECT_LEDGER_EFFECT_TOOL_NAMES.some((name) =>
          !authorizedNames.has(name),
        )
      ) {
        throw new Error(
          `required tool profile is ineligible for ${phase} phase: ${profile}`,
        );
      }
      continue;
    }
    const initialNames = profileInitialToolNames(profile, phase);
    if (initialNames.length === 0) {
      throw new Error(`required tool profile is ineligible for ${phase} phase: ${profile}`);
    }
    const missing = initialNames.find((name) => !retainedNames.has(name));
    if (missing) {
      throw new Error(
        `required tool profile is ineligible for ${phase} phase: ${profile} (${missing})`,
      );
    }
  }
}

function assertNonExecutionProfilesEffectFree(
  profiles: readonly string[],
  phase: GuidedTurnPhase,
): void {
  if (phase === "execution") return;
  for (const profile of profiles) {
    if (profile === "project") continue;
    const hasAvailableEffect = selectButlerToolsForProfiles([profile])
      .filter((tool) => !isGuidedRuntimeUnavailable(tool.name))
      .some((tool) =>
        BUTLER_TOOLS.find((candidate) => candidate.name === tool.name)
          ?.effectBoundary !== "none",
      );
    if (hasAvailableEffect) {
      throw new Error(
        `required tool profile is ineligible for ${phase} phase: ${profile}`,
      );
    }
  }
}

function assertRequiredToolsRetained(
  requiredToolNames: readonly string[],
  authorizedTools: readonly FunctionToolDefinition[],
  phase: GuidedTurnPhase,
  kind = "required tool",
): void {
  const retainedNames = new Set(authorizedTools.map((tool) => tool.name));
  for (const toolName of requiredToolNames) {
    if (!retainedNames.has(toolName)) {
      throw new Error(`${kind} is ineligible for ${phase} phase: ${toolName}`);
    }
  }
}

function isGuidedRuntimeUnavailable(name: string): boolean {
  return Object.hasOwn(GUIDED_NATIVE_TOOL_AVAILABILITY_OVERRIDES, name);
}

function isEnabled(env: Record<string, string | undefined>): boolean {
  return TRUE_FLAG_VALUES.has(env[FLAG_NAME]?.trim().toLowerCase() ?? "");
}

function guidedTurnPhase(policy: ButlerExecutionPolicy): GuidedTurnPhase {
  const hasWorkspaceAuthority = policy.requiredNativeToolProfiles
    .includes("workspace") || policy.requiredNativeTools.some((name) => {
      const category = TOOL_CAPABILITY_METADATA[name]?.category;
      return category === "command" || category === "file";
    });
  if (!policy.projectId && !hasWorkspaceAuthority) return "direct";
  return policy.accessMode === "read_only" ? "read_only" : "execution";
}

function phaseAllowsTool(
  phase: GuidedTurnPhase,
  tool: FunctionToolDefinition,
): boolean {
  if (phase === "execution") return true;
  const capability = TOOL_CAPABILITY_METADATA[tool.name];
  if (phase === "direct") {
    const native = BUTLER_TOOLS.find((candidate) => candidate.name === tool.name);
    return native?.effectBoundary === "none" &&
      capability?.category !== "project" &&
      capability?.category !== "command" &&
      capability?.category !== "file" &&
      capability?.category !== "work";
  }
  if (DURABLE_WORK_TOOL_DEFINITIONS.some((candidate) => candidate.name === tool.name)) {
    return false;
  }
  const native = BUTLER_TOOLS.find((candidate) => candidate.name === tool.name);
  return native?.effectBoundary === "none";
}

function removeRuntimeOwnedSchemaDefaults(
  tool: FunctionToolDefinition,
): FunctionToolDefinition {
  return {
    ...tool,
    parameters: removeSchemaDefaults(tool.parameters) as Record<string, unknown>,
  };
}

function removeSchemaDefaults(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(removeSchemaDefaults);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "default")
      .map(([key, nested]) => [key, removeSchemaDefaults(nested)]),
  );
}
