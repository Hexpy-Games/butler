import type { StoredSessionBinding } from
  "../../../test-support/harness/contracts.ts";
import { BUTLER_TOOLS } from "../../tools/butler-tools.ts";
import { selectButlerToolsForProfiles } from "../../tools/profiles.ts";
import type { SubsessionExecutionMode } from "./contracts.ts";

/** Inherit the parent authority ceiling; only a read-only Task narrows effects. */
export function inheritedStewardRuntimePolicy(
  parent: StoredSessionBinding,
  executionMode: SubsessionExecutionMode,
): Record<string, unknown> {
  const source = objectRecord(parent.metadata?.runtimePolicy);
  const trackingMode = trackingModeValue(
    source.trackingMode ?? source.tracking_mode,
  ) ?? (parent.projectId ? "ledger" : "local");
  const parentProfiles = stringValues(source.requiredNativeToolProfiles);
  const parentTools = stringValues(
    source.requiredNativeTools ?? source.required_tools,
  );
  const readOnly = executionMode === "read_only";
  const inherited = readOnly
    ? readOnlyAuthority(parentProfiles, parentTools)
    : { profiles: parentProfiles, tools: parentTools };
  return {
    ...source,
    accessMode: readOnly ? "read_only" : "full_access",
    trackingMode,
    tracking_mode: trackingMode,
    requiredNativeToolProfiles: inherited.profiles,
    requiredNativeTools: inherited.tools,
    required_tools: [...inherited.tools],
    authoritySource: "parent_session",
    authority_source: "parent_session",
  };
}

/** Keep the Steward root Work scope identical to its ordinary Turn scope. */
export function stewardRootWorkScope(
  binding: StoredSessionBinding,
): { projectRef?: string } {
  const source = objectRecord(binding.metadata?.runtimePolicy);
  const trackingMode = trackingModeValue(
    source.trackingMode ?? source.tracking_mode,
  ) ?? (binding.projectId ? "ledger" : "local");
  if (trackingMode !== "ledger") return {};
  const projectRef = binding.projectId?.trim();
  if (!projectRef) throw new Error("steward_project_binding_missing");
  return { projectRef };
}

function readOnlyAuthority(
  profiles: readonly string[],
  tools: readonly string[],
): { profiles: string[]; tools: string[] } {
  const inheritedProfiles: string[] = [];
  const inheritedTools = new Set(tools.filter(isEffectFreeTool));
  for (const profile of profiles) {
    const profileTools = selectButlerToolsForProfiles([profile]);
    if (profile === "project" || (
      profileTools.length > 0 && profileTools.every((tool) => isEffectFreeTool(tool.name))
    )) {
      inheritedProfiles.push(profile);
      continue;
    }
    for (const tool of profileTools) {
      if (isEffectFreeTool(tool.name)) inheritedTools.add(tool.name);
    }
  }
  return { profiles: inheritedProfiles, tools: [...inheritedTools] };
}

function isEffectFreeTool(name: string): boolean {
  return BUTLER_TOOLS.find((tool) => tool.name === name)?.effectBoundary === "none";
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValues(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string =>
      typeof item === "string" && Boolean(item.trim()),
    ).map((item) => item.trim()))]
    : [];
}

function trackingModeValue(value: unknown): "ledger" | "local" | "none" | null {
  return value === "ledger" || value === "local" || value === "none"
    ? value
    : null;
}
