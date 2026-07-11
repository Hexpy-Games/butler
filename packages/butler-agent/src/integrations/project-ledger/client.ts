import { spawnSync } from "child_process";
import { randomUUID } from "crypto";
import { existsSync } from "fs";
import { basename, join, resolve } from "path";
import { butlerAgentResourcesPath } from "../../runtime/paths.ts";
import { ActiveProjectLedgerResolver } from "./active-project-ledger-reference.ts";

const activeProjectLedgerResolver = new ActiveProjectLedgerResolver();

export function projectLedgerPath(input: { butlerHome: string }): string {
  const packagedPath = join(input.butlerHome, "packages", "project-ledger", "bin", "project-ledger");
  if (existsSync(packagedPath)) return packagedPath;
  return butlerAgentResourcesPath(input.butlerHome, "skills", "project-ledger", "bin", "project-ledger");
}

export function projectLedgerProjectPath(
  input: {
    butlerHome: string;
    butlerData?: string;
    workspacePath?: string;
    projectId?: string;
    appMessageDbPath?: string;
  },
  args: Record<string, unknown>,
): string {
  const explicitRef = stringArg(args, "project_ref") || stringArg(args, "project_path");
  if (!input.butlerData) return explicitRef || input.workspacePath || input.butlerHome;
  try {
    return activeProjectLedgerResolver.resolve({
      butlerData: input.butlerData,
      appMessageDbPath: input.appMessageDbPath,
      appProjectId: input.projectId,
      workspacePath: input.workspacePath,
      explicitRef: explicitRef || undefined,
      fallbackWorkspacePath: input.projectId || input.workspacePath ? undefined : input.butlerHome,
    }).ledger_root;
  } catch {
    throw new Error("project_ledger_project_resolution_failed: active project session has no resolvable Project Ledger reference");
  }
}

export function runProjectLedgerTool(
  input: { butlerHome: string; butlerData?: string },
  args: string[],
): Record<string, unknown> {
  const result = spawnSync(process.execPath, [projectLedgerPath(input), ...args, "--json"], {
    cwd: input.butlerHome,
    encoding: "utf8",
    env: {
      ...process.env,
      BUTLER_HOME: input.butlerHome,
      ...(input.butlerData ? { BUTLER_DATA: input.butlerData } : {}),
    },
    timeout: 10_000,
  });
  if (result.stdout.trim()) {
    try {
      return JSON.parse(result.stdout) as Record<string, unknown>;
    } catch {
      return {
        ok: false,
        error: {
          code: "project_ledger_invalid_json",
          message: "Project Ledger returned invalid JSON",
        },
      };
    }
  }
  return {
    ok: false,
    error: {
      code: result.error ? "project_ledger_spawn_failed" : "project_ledger_failed",
      message: result.error?.message ?? (result.stderr.trim() || `Project Ledger exited with ${result.status ?? 1}`),
    },
  };
}

export function projectLedgerRenderedViewEvidence(input: {
  projectPath: string;
  result: Record<string, unknown>;
  view: string;
  write: boolean;
}): Record<string, unknown> {
  if (!input.write || input.result.ok === false) return {};
  const data = input.result.data && typeof input.result.data === "object" && !Array.isArray(input.result.data)
    ? input.result.data as Record<string, unknown>
    : {};
  if (data.written !== true || typeof data.path !== "string" || !data.path.trim()) return {};
  const relativePath = data.path.trim();
  const artifactPath = projectLedgerArtifactPath(input.projectPath, relativePath);
  return {
    durable_artifact_created: true,
    artifact_kind: "markdown_file",
    artifact_label: relativePath,
    artifact_path: artifactPath,
    evidence_receipts: [
      {
        schema: "butler.evidence-receipt.v1",
        id: `receipt-render_project_dashboard-${randomUUID()}`,
        producer: { kind: "tool", name: "render_project_dashboard" },
        receiptType: "artifact",
        verified: true,
        covers: ["project_ledger_view", "durable_artifact"],
        summary: "Project Ledger generated view was written as a durable markdown artifact.",
        references: [{ kind: "project_document", ref: relativePath, label: basename(relativePath) }],
        artifacts: [
          {
            label: relativePath,
            path: artifactPath,
            mediaType: "text/markdown",
            role: "project_ledger_view",
          },
        ],
        satisfies: ["durable_artifact"],
      },
    ],
    verified_output_files: [
      {
        path: relativePath,
        artifact_kind: "markdown_file",
      },
    ],
  };
}

function projectLedgerArtifactPath(projectPath: string, relativePath: string): string {
  const normalizedRelativePath = relativePath.split("\\").join("/");
  if (normalizedRelativePath === "project-ledger" || normalizedRelativePath.startsWith("project-ledger/")) {
    return resolve(projectPath, "..", "..", "..", normalizedRelativePath);
  }
  return resolve(projectPath, relativePath);
}

function stringArg(args: Record<string, unknown>, key: string): string {
  return typeof args[key] === "string" && args[key].trim() ? args[key].trim() : "";
}
