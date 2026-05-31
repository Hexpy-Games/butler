import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { join, resolve } from "path";
import { butlerAgentResourcesPath } from "../../runtime/paths.ts";

export function projectLedgerPath(input: { butlerHome: string }): string {
  const packagedPath = join(input.butlerHome, "packages", "project-ledger", "bin", "project-ledger");
  if (existsSync(packagedPath)) return packagedPath;
  return butlerAgentResourcesPath(input.butlerHome, "skills", "project-ledger", "bin", "project-ledger");
}

export function projectLedgerProjectPath(input: { butlerHome: string }, args: Record<string, unknown>): string {
  return typeof args.project_path === "string" && args.project_path.trim()
    ? args.project_path.trim()
    : input.butlerHome;
}

export function runProjectLedgerTool(input: { butlerHome: string }, args: string[]): Record<string, unknown> {
  const result = spawnSync(process.execPath, [projectLedgerPath(input), ...args, "--json"], {
    cwd: input.butlerHome,
    encoding: "utf8",
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
  const fallbackPath = `.project-ledger/views/${safeViewName(input.view)}.md`;
  const relativePath = typeof data.path === "string" && data.path.trim()
    ? data.path.trim()
    : fallbackPath;
  const artifactPath = resolve(input.projectPath, relativePath);
  return {
    durable_artifact_created: true,
    artifact_kind: "markdown_file",
    artifact_label: relativePath,
    artifact_path: artifactPath,
    verified_output_files: [
      {
        path: relativePath,
        artifact_kind: "markdown_file",
      },
    ],
  };
}

function safeViewName(view: string): string {
  return view.replace(/[^a-zA-Z0-9_-]/gu, "-").replace(/-+/gu, "-") || "view";
}
