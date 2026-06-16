import {
  projectLedgerProjectPath,
  projectLedgerRenderedViewEvidence,
  runProjectLedgerTool,
} from "../../../integrations/project-ledger/client.ts";
import { createWorkDashboard } from "../../work/work-dashboard.ts";

type ToolCall = { args: Record<string, unknown> };
type ProjectLedgerExecutorInput = {
  butlerHome: string;
  butlerData: string;
  sessionId?: string;
  projectId?: string;
};

export function createProjectLedgerToolHandlers(input: ProjectLedgerExecutorInput) {
  return {
    "get_work_dashboard": async (call: ToolCall) => ({
      ok: true,
      ...createWorkDashboard({
        butlerData: input.butlerData,
        debug: call.args.debug === true,
        limit: typeof call.args.limit === "number" ? call.args.limit : undefined,
      }),
    }),
    "inspect_project_status": async (call: ToolCall) => {
      const projectPath = projectLedgerProjectPath(input, call.args);
      return runProjectLedgerTool(input, [
        "status",
        "--project",
        projectPath,
      ]);
    },
    "query_project_work": async (call: ToolCall) => {
      const kind = typeof call.args.kind === "string" ? call.args.kind.trim() : "";
      if (!kind) throw new Error("query_project_work requires kind");
      const projectPath = projectLedgerProjectPath(input, call.args);
      return runProjectLedgerTool(input, [
        "query",
        "--project",
        projectPath,
        "--kind",
        kind,
      ]);
    },
    "render_project_dashboard": async (call: ToolCall) => {
      const view = typeof call.args.view === "string" ? call.args.view.trim() : "";
      if (!view) throw new Error("render_project_dashboard requires view");
      const projectPath = projectLedgerProjectPath(input, call.args);
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
      const id = typeof call.args.id === "string" ? call.args.id.trim() : "";
      const validation = typeof call.args.validation === "string" ? call.args.validation.trim() : "";
      const review = typeof call.args.review === "string" ? call.args.review.trim() : "";
      const report = typeof call.args.report === "string" ? call.args.report.trim() : "";
      if (!id) throw new Error("complete_project_work requires id");
      if (!validation || !review || !report) {
        throw new Error("complete_project_work requires validation review and report");
      }
      return runProjectLedgerTool(input, [
        "work",
        "complete",
        "--project",
        projectLedgerProjectPath(input, call.args),
        "--id",
        id,
        "--validation",
        validation,
        "--review",
        review,
        "--report",
        report,
      ]);
    },
  };
}
