import type { CompiledTurnContract } from "../../turn-contract.ts";
import type { ButlerToolProfile } from "../../../tools/profiles.ts";

export function turnMetadataForContract(
  contract: CompiledTurnContract,
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const readOnlyAction = contract.action === "inspect" || contract.action === "tool_answer";
  const preservedProfiles = existingPolicyStrings(
    metadata,
    ["requiredNativeToolProfiles", "required_tool_profiles"],
  ).filter((profile) =>
    !readOnlyAction ||
    (profile !== "workspace" && profile !== "project-lifecycle"),
  );
  const profiles = unionStrings(
    preservedProfiles,
    contractProfiles(contract),
  );
  const tools = unionStrings(
    existingPolicyStrings(metadata, ["requiredNativeTools", "required_tools"]),
    contractTools(contract),
  );
  const trackingMode = effectiveTrackingMode(contract.tracking_mode, metadata);
  const accessMode = readOnlyAction ? "read_only" : "full";
  const toolSurfaceMode = readOnlyAction ? "fixed" : "adaptive";
  const policy = {
    contractId: contract.contract_id,
    contract_id: contract.contract_id,
    workstreamId: contract.target_workstream_id,
    workstream_id: contract.target_workstream_id,
    trackingMode,
    tracking_mode: trackingMode,
    closeoutStrategy: contract.closeout_strategy,
    closeout_strategy: contract.closeout_strategy,
    accessMode,
    access_mode: accessMode,
    toolSurfaceMode,
    tool_surface_mode: toolSurfaceMode,
    requiredNativeToolProfiles: profiles,
    required_tool_profiles: profiles,
    requiredNativeTools: tools,
    required_tools: tools,
  };
  return {
    ...(metadata ?? {}),
    ...policy,
    runtimePolicy: {
      ...record(metadata?.runtimePolicy),
      ...policy,
    },
  };
}

function effectiveTrackingMode(
  contractMode: CompiledTurnContract["tracking_mode"],
  metadata: Record<string, unknown> | undefined,
): CompiledTurnContract["tracking_mode"] {
  const runtimePolicy = record(metadata?.runtimePolicy);
  const existing = [
    metadata?.trackingMode,
    metadata?.tracking_mode,
    runtimePolicy.trackingMode,
    runtimePolicy.tracking_mode,
  ].find((value) => value === "ledger" || value === "local" || value === "none");
  const rank = { none: 0, local: 1, ledger: 2 } as const;
  return existing && rank[existing] > rank[contractMode]
    ? existing
    : contractMode;
}

function existingPolicyStrings(
  metadata: Record<string, unknown> | undefined,
  keys: readonly string[],
): string[] {
  const runtimePolicy = record(metadata?.runtimePolicy);
  return unionStrings(
    ...keys.map((key) => stringArray(metadata?.[key])),
    ...keys.map((key) => stringArray(runtimePolicy[key])),
  );
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) =>
    typeof item === "string" && item.trim() ? [item.trim()] : [],
  );
}

function unionStrings(...groups: readonly string[][]): string[] {
  return [...new Set(groups.flat())];
}

function contractProfiles(contract: CompiledTurnContract): ButlerToolProfile[] {
  const profiles = new Set<ButlerToolProfile>();
  if (contract.action === "tool_answer" && contract.evidence_domain === "public_web") {
    profiles.add("public-web");
  }
  if (contract.action === "inspect" && contract.target_project_id) profiles.add("project");
  if (contract.tracking_mode === "ledger") {
    profiles.add("project");
    if (contract.action !== "inspect") profiles.add("project-lifecycle");
  }
  if (contract.tracking_mode === "local" || contract.deliverables.some((item) =>
    item === "code_change" || item === "validation" || item === "review")) {
    profiles.add("workspace");
  }
  return [...profiles];
}

function contractTools(contract: CompiledTurnContract): string[] {
  const tools = new Set<string>();
  if (contract.action === "tool_answer" && contract.evidence_domain === "public_web") {
    tools.add("web_search");
    tools.add("web_read");
    tools.add("read_tool_evidence_artifact");
  }
  if (contract.target_project_id && contract.deliverables.includes("status_report")) {
    tools.add("project_ledger_status");
    tools.add("project_ledger_show");
  }
  if (contract.action === "inspect" && !contract.target_project_id) {
    tools.add("grep_files");
    tools.add("read_file");
    tools.add("read_tool_evidence_artifact");
    tools.add("read_tool_output_artifact");
  }
  if (contract.deliverables.some((item) => item.startsWith("ledger_"))) {
    tools.add("project_ledger_status");
    tools.add("project_ledger_list");
    tools.add("project_ledger_show");
    tools.add("project_ledger_create");
    tools.add("project_ledger_update");
  }
  if (contract.target_workstream_id) {
    tools.add("list_work_streams");
    tools.add("list_todo_list");
    tools.add("update_todo_list");
  }
  return [...tools].sort();
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
