import { expect, test } from "bun:test";
import { compileTurnContract } from "../../packages/butler-agent/src/agent/turn/turn-contract.ts";
import { turnMetadataForContract } from "../../packages/butler-agent/src/agent/turn/native/turn-runner/turn-contract-tool-policy.ts";
import { selectButlerToolsForTurn } from "../../packages/butler-agent/src/agent/tools/profiles.ts";

test("typed turn contracts preserve structured session tool policy", () => {
  const contract = compileTurnContract({
    decision: {
      schema_version: "butler.turn-contract-decision.v1",
      decision_id: "decision-preserve-session-tools",
      action: "inspect",
      deliverables: ["status_report"],
      public_summary: "Inspect the requested project state.",
    },
  });

  const metadata = turnMetadataForContract(contract, {
    requiredNativeTools: ["query_project_work"],
    runtimePolicy: {
      trackingMode: "ledger",
      requiredNativeToolProfiles: ["project"],
      required_tools: ["render_project_dashboard"],
    },
  });

  expect(metadata.requiredNativeToolProfiles).toEqual(["project"]);
  expect(metadata.requiredNativeTools).toEqual([
    "query_project_work",
    "render_project_dashboard",
    "grep_files",
    "read_file",
    "read_tool_evidence_artifact",
    "read_tool_output_artifact",
  ]);
  expect(metadata.runtimePolicy).toMatchObject({
    requiredNativeToolProfiles: ["project"],
    required_tools: [
      "query_project_work",
      "render_project_dashboard",
      "grep_files",
      "read_file",
      "read_tool_evidence_artifact",
      "read_tool_output_artifact",
    ],
    accessMode: "read_only",
    trackingMode: "ledger",
  });
});

test("fixed contract surfaces retain turn-scoped project profiles without full-access mutations", () => {
  const tools = selectButlerToolsForTurn({
    role: "butler",
    sessionMetadata: {
      requiredNativeToolProfiles: ["workspace", "project", "project-lifecycle"],
    },
    turnMetadata: {
      requiredNativeToolProfiles: ["project"],
      requiredNativeTools: ["read_file"],
      trackingMode: "ledger",
      accessMode: "read_only",
      toolSurfaceMode: "fixed",
    },
  }).map((tool) => tool.name);

  expect(tools).toContain("inspect_project_status");
  expect(tools).toContain("query_project_work");
  expect(tools).toContain("render_project_dashboard");
  expect(tools).toContain("read_file");
  expect(tools).not.toContain("write_file");
  expect(tools).not.toContain("project_ledger_create");
});

test("mixed work contracts with a status obligation retain exact status producers", () => {
  const contract = compileTurnContract({
    decision: {
      schema_version: "butler.turn-contract-decision.v1",
      decision_id: "decision-mixed-status-work",
      action: "start_work",
      target_project_id: "project-a",
      deliverables: ["status_report", "code_change"],
      public_summary: "Inspect current state and apply the requested change.",
    },
  });

  const metadata = turnMetadataForContract(contract, {});
  expect(metadata.requiredNativeTools).toEqual([
    "project_ledger_show",
    "project_ledger_status",
  ]);
  expect(metadata.requiredNativeToolProfiles).toEqual(["workspace"]);
});
