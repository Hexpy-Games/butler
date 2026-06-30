import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

export type ProjectDocumentSourceProject = {
  id: string;
  display_name: string;
  workspace_path: string;
  workspace_label: string;
  safe_path_label: string;
};

export function projectLedgerDataRootCandidates(
  butlerDataRoot: string,
  project: ProjectDocumentSourceProject,
): Array<{ root: string; safeRootLabel: string }> {
  const seen = new Set<string>();
  return projectLedgerProjectIdCandidates(project).flatMap((candidate) => {
    const segment = safeProjectLedgerSegment(candidate);
    if (seen.has(segment)) return [];
    seen.add(segment);
    return [
      {
        root: resolve(butlerDataRoot, "project-ledger", "projects", segment),
        safeRootLabel: `project-ledger/projects/${segment}`,
      },
    ];
  });
}

function projectLedgerProjectIdCandidates(
  project: ProjectDocumentSourceProject,
): string[] {
  const workspacePath = project.workspace_path;
  return uniqueNonEmptyText([
    workspacePath
      ? readProjectJsonString(resolve(workspacePath, "project.json"), "id")
      : null,
    workspacePath
      ? readProjectJsonString(resolve(workspacePath, "package.json"), "name")
      : null,
    workspacePath ? basename(workspacePath) : null,
    project.safe_path_label,
    project.workspace_label,
    project.display_name,
    project.id,
  ]);
}

function uniqueNonEmptyText(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function readProjectJsonString(path: string, key: string): string | null {
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Record<
      string,
      unknown
    >;
    const candidate = value[key];
    return typeof candidate === "string" && candidate.trim()
      ? candidate.trim()
      : null;
  } catch {
    return null;
  }
}

function safeProjectLedgerSegment(value: string): string {
  const safe = value
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  if (safe) return safe.slice(0, 96);
  return "project";
}
