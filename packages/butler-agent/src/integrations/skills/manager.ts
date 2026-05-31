import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import { spawnSync } from "child_process";
import {
  loadSkillCatalog,
  validateSkillCatalog,
  type SkillDefinition,
  type SkillValidationIssue,
} from "./catalog.ts";
import { butlerAgentResourcesPath } from "../../runtime/paths.ts";

export interface SkillSummaryView {
  name: string;
  description: string;
  applicability: string;
  source: "core" | "user" | "project";
  project_id?: string;
  file_path: string;
  user_invocable: boolean;
}

export interface SkillProjectView {
  id: string;
  display_name: string;
  skills: SkillSummaryView[];
}

export interface SkillSettingsView {
  storage_root: string;
  core: SkillSummaryView[];
  user: SkillSummaryView[];
  projects: SkillProjectView[];
}

export interface SkillImportResult {
  imported: SkillSummaryView[];
  skipped: string[];
}

export interface SkillValidationViewIssue extends SkillValidationIssue {
  source: SkillSummaryView["source"];
  project_id?: string;
}

export interface SkillValidationView {
  ok: boolean;
  counts: {
    core: number;
    user: number;
    project: number;
  };
  issues: SkillValidationViewIssue[];
}

export function skillSettingsView(input: {
  butlerHome: string;
  butlerData: string;
  projects: Array<{ id: string; display_name: string }>;
}): SkillSettingsView {
  return {
    storage_root: skillsDataRoot(input.butlerData),
    core: skillSummaries(loadSkillCatalog(butlerAgentResourcesPath(input.butlerHome, "skills")), "core"),
    user: skillSummaries(loadSkillCatalog(userSkillsDir(input.butlerData)), "user"),
    projects: input.projects.map((project) => ({
      id: project.id,
      display_name: project.display_name,
      skills: skillSummaries(
        loadSkillCatalog(projectSkillsDir(input.butlerData, project.id)),
        "project",
        project.id,
      ),
    })),
  };
}

export function loadRuntimeSkills(input: {
  butlerHome: string;
  butlerData: string;
  projectId?: string;
}): SkillDefinition[] {
  return [
    ...loadSkillCatalog(butlerAgentResourcesPath(input.butlerHome, "skills")),
    ...loadSkillCatalog(userSkillsDir(input.butlerData)),
    ...(input.projectId
      ? loadSkillCatalog(projectSkillsDir(input.butlerData, input.projectId))
      : []),
  ];
}

export function listSkillProjectsInDataHome(butlerData: string): SkillProjectView[] {
  const root = projectSkillsRoot(butlerData);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      id: entry.name,
      display_name: entry.name,
      skills: skillSummaries(loadSkillCatalog(join(root, entry.name)), "project", entry.name),
    }));
}

export function validateSkillSettings(input: {
  butlerHome: string;
  butlerData: string;
  projectIds?: string[];
}): SkillValidationView {
  const core = loadSkillCatalog(butlerAgentResourcesPath(input.butlerHome, "skills"));
  const user = loadSkillCatalog(userSkillsDir(input.butlerData));
  const projectIds = input.projectIds ?? listSkillProjectsInDataHome(input.butlerData).map((project) => project.id);
  const projectScopes = projectIds.map((projectId) => ({
    projectId,
    skills: loadSkillCatalog(projectSkillsDir(input.butlerData, projectId)),
  }));
  const issues: SkillValidationViewIssue[] = [
    ...validateSkillCatalog(core).map((issue) => ({ ...issue, source: "core" as const })),
    ...validateSkillCatalog(user).map((issue) => ({ ...issue, source: "user" as const })),
    ...projectScopes.flatMap((scope) =>
      validateSkillCatalog(scope.skills).map((issue) => ({
        ...issue,
        source: "project" as const,
        project_id: scope.projectId,
      })),
    ),
  ];
  return {
    ok: issues.length === 0,
    counts: {
      core: core.length,
      user: user.length,
      project: projectScopes.reduce((sum, scope) => sum + scope.skills.length, 0),
    },
    issues,
  };
}

export function importSkillZip(input: {
  butlerData: string;
  zipName: string;
  bytes: ArrayBuffer;
  projectId?: string;
}): SkillImportResult {
  const importId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const tmpRoot = join(tmpdir(), `butler-skill-import-${importId}`);
  const zipPath = join(tmpRoot, basename(input.zipName || "skill.zip"));
  const targetRoot = input.projectId
    ? projectSkillsDir(input.butlerData, input.projectId)
    : userSkillsDir(input.butlerData);
  mkdirSync(tmpRoot, { recursive: true, mode: 0o700 });
  mkdirSync(targetRoot, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(zipPath, new Uint8Array(input.bytes));
    const result = spawnSync("unzip", ["-q", zipPath, "-d", tmpRoot], {
      encoding: "utf8",
    });
    if ((result.status ?? 1) !== 0) {
      throw new Error(result.stderr.trim() || "Failed to unzip skill archive.");
    }
    const candidates = findSkillDirs(tmpRoot);
    const imported: SkillSummaryView[] = [];
    const skipped: string[] = [];
    for (const sourceDir of candidates) {
      const name = safeSkillDirName(basename(sourceDir));
      if (!name) {
        skipped.push(sourceDir);
        continue;
      }
      const targetDir = join(targetRoot, name);
      rmSync(targetDir, { recursive: true, force: true });
      cpSync(sourceDir, targetDir, { recursive: true });
      const skill = loadSkillCatalog(targetRoot).find((item) => item.filePath.startsWith(targetDir));
      if (skill) imported.push(skillSummary(skill, input.projectId ? "project" : "user", input.projectId));
    }
    return { imported, skipped };
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function skillsDataRoot(butlerData: string): string {
  return join(butlerData, "skills");
}

function userSkillsDir(butlerData: string): string {
  return join(skillsDataRoot(butlerData), "default");
}

function projectSkillsRoot(butlerData: string): string {
  return join(skillsDataRoot(butlerData), "projects");
}

function projectSkillsDir(butlerData: string, projectId: string): string {
  return join(projectSkillsRoot(butlerData), safeSkillDirName(projectId));
}

function skillSummaries(
  skills: SkillDefinition[],
  source: SkillSummaryView["source"],
  projectId?: string,
): SkillSummaryView[] {
  return skills.map((skill) => skillSummary(skill, source, projectId));
}

function skillSummary(
  skill: SkillDefinition,
  source: SkillSummaryView["source"],
  projectId?: string,
): SkillSummaryView {
  return {
    name: skill.name,
    description: skill.description,
    applicability: skill.applicability,
    source,
    project_id: projectId,
    file_path: skill.filePath,
    user_invocable: skill.userInvocable,
  };
}

function findSkillDirs(root: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const fullPath = join(root, entry.name);
    if (existsSync(join(fullPath, "SKILL.md"))) found.push(fullPath);
    else found.push(...findSkillDirs(fullPath));
  }
  return found;
}

function safeSkillDirName(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
}
