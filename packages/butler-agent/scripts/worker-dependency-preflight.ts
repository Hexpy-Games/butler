#!/usr/bin/env bun

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { basename, join } from "path";

export type WorkerDependencyPreflightStatus = "ok" | "needs_dependency_setup" | "not_applicable";

export interface WorkerDependencyPreflightResult {
  status: WorkerDependencyPreflightStatus;
  project_path: string;
  package_json_path: string | null;
  package_manager: string | null;
  install_command: string | null;
  findings: string[];
  validation_guidance: string[];
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function scriptText(packageJson: Record<string, unknown>): string {
  const scripts = packageJson.scripts && typeof packageJson.scripts === "object"
    ? packageJson.scripts as Record<string, unknown>
    : {};
  return Object.values(scripts)
    .filter((value): value is string => typeof value === "string")
    .join("\n");
}

function detectPackageManager(projectPath: string, packageJson: Record<string, unknown>): string {
  const packageManager = typeof packageJson.packageManager === "string" ? packageJson.packageManager : "";
  if (packageManager.startsWith("bun@")) return "bun";
  if (packageManager.startsWith("pnpm@")) return "pnpm";
  if (packageManager.startsWith("yarn@")) return "yarn";
  if (packageManager.startsWith("npm@")) return "npm";
  if (existsSync(join(projectPath, "bun.lock")) || existsSync(join(projectPath, "bun.lockb"))) return "bun";
  if (existsSync(join(projectPath, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(projectPath, "yarn.lock"))) return "yarn";
  if (existsSync(join(projectPath, "package-lock.json"))) return "npm";
  return "bun";
}

function installCommand(packageManager: string): string {
  if (packageManager === "pnpm") return "pnpm install";
  if (packageManager === "yarn") return "yarn install";
  if (packageManager === "npm") return "npm install";
  return "bun install";
}

function hasDependencyDeclarations(packageJson: Record<string, unknown>): boolean {
  return ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].some((key) => {
    const value = packageJson[key];
    return Boolean(value && typeof value === "object" && Object.keys(value).length > 0);
  });
}

export function inspectWorkerDependencyPreflight(projectPath: string): WorkerDependencyPreflightResult {
  const packageJsonPath = join(projectPath, "package.json");
  if (!existsSync(packageJsonPath)) {
    return {
      status: "not_applicable",
      project_path: projectPath,
      package_json_path: null,
      package_manager: null,
      install_command: null,
      findings: [`No package.json found at ${packageJsonPath}.`],
      validation_guidance: ["No Node dependency preflight is required for this project path."],
    };
  }

  const packageJson = readJson(packageJsonPath);
  if (!packageJson) {
    return {
      status: "needs_dependency_setup",
      project_path: projectPath,
      package_json_path: packageJsonPath,
      package_manager: null,
      install_command: null,
      findings: [`package.json exists but could not be parsed at ${packageJsonPath}.`],
      validation_guidance: ["Fix package.json before running dependency-based validation commands."],
    };
  }

  const manager = detectPackageManager(projectPath, packageJson);
  const install = installCommand(manager);
  const nodeModulesPath = join(projectPath, "node_modules");
  const localTscPath = join(nodeModulesPath, ".bin", "tsc");
  const scripts = scriptText(packageJson);
  const findings: string[] = [];
  const guidance: string[] = [];
  const needsDependencies = hasDependencyDeclarations(packageJson) && !existsSync(nodeModulesPath);
  const usesTsc = /\btsc\b/u.test(scripts);
  const missingLocalTsc = usesTsc && !existsSync(localTscPath);

  if (needsDependencies) {
    findings.push(`${basename(projectPath)} declares package dependencies but node_modules is missing.`);
  }
  if (missingLocalTsc) {
    findings.push("package scripts reference tsc but node_modules/.bin/tsc is missing.");
  }

  if (findings.length > 0) {
    guidance.push(`Run \`${install}\` in ${projectPath} before typecheck, lint, test, or direct tsc commands that require project dependencies.`);
    guidance.push("Treat missing dependency/tool binaries as environment setup blockers, not as code failures.");
    return {
      status: "needs_dependency_setup",
      project_path: projectPath,
      package_json_path: packageJsonPath,
      package_manager: manager,
      install_command: install,
      findings,
      validation_guidance: guidance,
    };
  }

  return {
    status: "ok",
    project_path: projectPath,
    package_json_path: packageJsonPath,
    package_manager: manager,
    install_command: install,
    findings: ["Node dependency preflight found local dependency state ready enough for validation commands."],
    validation_guidance: ["Proceed with requested verification commands normally."],
  };
}

export function renderWorkerDependencyPreflightMarkdown(result: WorkerDependencyPreflightResult): string {
  return [
    "Worker dependency preflight",
    "",
    `Status: ${result.status}`,
    `Project path: ${result.project_path}`,
    result.package_json_path ? `Package manifest: ${result.package_json_path}` : "Package manifest: none",
    result.package_manager ? `Package manager: ${result.package_manager}` : "Package manager: none",
    result.install_command ? `Install command: ${result.install_command}` : "Install command: none",
    "",
    "Findings:",
    ...result.findings.map((finding) => `- ${finding}`),
    "",
    "Validation guidance:",
    ...result.validation_guidance.map((item) => `- ${item}`),
  ].join("\n");
}

export function runWorkerDependencyPreflight(input: {
  taskDir: string;
  projectPath: string;
}): WorkerDependencyPreflightResult {
  mkdirSync(input.taskDir, { recursive: true });
  const result = inspectWorkerDependencyPreflight(input.projectPath);
  writeFileSync(join(input.taskDir, "worker-preflight.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  writeFileSync(join(input.taskDir, "worker-preflight.md"), `${renderWorkerDependencyPreflightMarkdown(result)}\n`, "utf8");
  return result;
}

if (import.meta.main) {
  const [, , taskDir, projectPath] = process.argv;
  if (!taskDir || !projectPath) {
    console.error("Usage: worker-dependency-preflight.ts <task_dir> <project_path>");
    process.exit(1);
  }
  const result = runWorkerDependencyPreflight({ taskDir, projectPath });
  process.stdout.write(`${renderWorkerDependencyPreflightMarkdown(result)}\n`);
}
