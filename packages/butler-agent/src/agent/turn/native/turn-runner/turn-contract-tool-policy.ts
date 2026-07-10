import type { CompiledTurnContract } from "../../turn-contract.ts";
import type { ButlerToolProfile } from "../../../tools/profiles.ts";

export function turnMetadataForContract(
  contract: CompiledTurnContract,
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const profiles = contractProfiles(contract);
  const tools = contractTools(contract);
  const accessMode = contract.action === "inspect" ? "read_only" : "full";
  const policy = {
    contractId: contract.contract_id,
    contract_id: contract.contract_id,
    workstreamId: contract.target_workstream_id,
    workstream_id: contract.target_workstream_id,
    trackingMode: contract.tracking_mode,
    tracking_mode: contract.tracking_mode,
    closeoutStrategy: contract.closeout_strategy,
    closeout_strategy: contract.closeout_strategy,
    accessMode,
    access_mode: accessMode,
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

function contractProfiles(contract: CompiledTurnContract): ButlerToolProfile[] {
  const profiles = new Set<ButlerToolProfile>();
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
  if (contract.action === "inspect" && contract.target_project_id) {
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
    tools.add("project_ledger_create");
    tools.add("project_ledger_update");
  }
  if (contract.target_workstream_id) {
    tools.add("list_work_streams");
    tools.add("list_todo_list");
    tools.add("update_todo_list");
    tools.add("update_work_stream_state");
  }
  return [...tools].sort();
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
