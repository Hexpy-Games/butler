import {
  projectLedgerProjectPath,
  projectLedgerRenderedViewEvidence,
  runProjectLedgerTool,
} from "../../../integrations/project-ledger/client.ts";
import { createEvidenceCapabilityReceipt } from "../../output/evidence/ledger.ts";
import { createWorkDashboard } from "../../work/work-dashboard.ts";
import { createProjectLedgerNativeToolHandler } from "./native.ts";
import type { WorkspaceReference } from "../../session-workspaces/index.ts";

type ToolCall = { args: Record<string, unknown> };
type ProjectLedgerExecutorInput = {
  butlerHome: string;
  butlerData: string;
  appMessageDbPath?: string;
  workspacePath?: string;
  sessionId?: string;
  projectId?: string;
  workspaceReference?: WorkspaceReference;
};

function activeWorkspacePath(input: ProjectLedgerExecutorInput): string | undefined {
  return input.workspaceReference?.get() ?? input.workspacePath;
}

export function createProjectLedgerToolHandlers(input: ProjectLedgerExecutorInput) {
  return {
    "get_work_dashboard": async (call: ToolCall) => ({
      ok: true,
      ...createWorkDashboard({
        butlerData: input.butlerData,
        debug: call.args.debug === true,
        limit: typeof call.args.limit === "number" ? call.args.limit : undefined,
      }),
      evidence_capability_receipts: projectLedgerSourceCapabilityReceipts({
        toolName: "get_work_dashboard",
        summary: "Canonical Butler work dashboard state was inspected.",
        reference: { task_id: "work-dashboard" },
      }),
    }),
    "inspect_project_status": async (call: ToolCall) => {
      const projectPath = projectLedgerProjectPath({ ...input, workspacePath: activeWorkspacePath(input) }, call.args);
      const result = runProjectLedgerTool(input, [
        "status",
        "--project",
        projectPath,
      ]);
      return withProjectLedgerSourceEvidence(result, {
        toolName: "inspect_project_status",
        summary: "Canonical Project Ledger status was inspected.",
        reference: { task_id: "project-ledger-status" },
      });
    },
    "query_project_work": async (call: ToolCall) => {
      const kind = typeof call.args.kind === "string" ? call.args.kind.trim() : "";
      if (!kind) throw new Error("query_project_work requires kind");
      const projectPath = projectLedgerProjectPath({ ...input, workspacePath: activeWorkspacePath(input) }, call.args);
      const result = runProjectLedgerTool(input, [
        "query",
        "--project",
        projectPath,
        "--kind",
        kind,
      ]);
      return withProjectLedgerSourceEvidence(result, {
        toolName: "query_project_work",
        summary: `Canonical Project Ledger ${kind} query results were inspected.`,
        reference: { task_id: `project-ledger-query:${kind}` },
      });
    },
    "render_project_dashboard": async (call: ToolCall) => {
      const view = typeof call.args.view === "string" ? call.args.view.trim() : "";
      if (!view) throw new Error("render_project_dashboard requires view");
      const projectPath = projectLedgerProjectPath({ ...input, workspacePath: activeWorkspacePath(input) }, call.args);
      const args = [
        "render",
        "--project",
        projectPath,
        view,
      ];
      if (call.args.write === true) args.push("--write");
      const result = runProjectLedgerTool(input, args);
      return {
        ...result,
        ...projectLedgerRenderedViewEvidence({
          projectPath,
          result,
          view,
          write: call.args.write === true,
        }),
      };
    },
    "complete_project_work": async (call: ToolCall) => {
      const handler = createProjectLedgerNativeToolHandler(input, "project_ledger_work_complete");
      return handler(call);
    },
  };
}

function withProjectLedgerSourceEvidence(
  result: Record<string, unknown>,
  input: Parameters<typeof projectLedgerSourceCapabilityReceipts>[0],
): Record<string, unknown> {
  if (!isProjectLedgerCliEnvelope(result) || isUninitializedProjectLedgerRead(result)) {
    return result;
  }
  return {
    ...result,
    evidence_capability_receipts: projectLedgerSourceCapabilityReceipts(input),
  };
}

function isUninitializedProjectLedgerRead(result: Record<string, unknown>): boolean {
  const data = result.data && typeof result.data === "object" &&
      !Array.isArray(result.data)
    ? result.data as Record<string, unknown>
    : null;
  return data?.initialized === false;
}

function isProjectLedgerCliEnvelope(result: Record<string, unknown>): boolean {
  return typeof result.command === "string" &&
    result.privacy !== null &&
    typeof result.privacy === "object" &&
    !Array.isArray(result.privacy);
}

function projectLedgerSourceCapabilityReceipts(input: {
  toolName: string;
  summary: string;
  reference: { task_id: string };
}) {
  return [createEvidenceCapabilityReceipt({
    producer: { kind: "tool", name: input.toolName },
    capability: "source_verified",
    evidence_kind: "project_state",
    maturity: "verified",
    verified: true,
    confidence: 0.9,
    summary: input.summary,
    references: [input.reference],
    satisfies: ["source_verified"],
    limitations: [],
  })];
}
