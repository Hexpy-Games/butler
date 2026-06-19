import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  inspectWorkerDependencyPreflight,
  runWorkerDependencyPreflight,
} from "../../packages/butler-agent/scripts/worker-dependency-preflight.ts";

function tempRoot(): string {
  const root = join(tmpdir(), `butler-worker-preflight-${Date.now()}-${Math.random()}`);
  mkdirSync(root, { recursive: true });
  return root;
}

test("worker dependency preflight flags missing worktree dependencies before validation", () => {
  const root = tempRoot();
  const projectPath = join(root, "butler-worktree");
  const taskDir = join(root, "tasks", "worker-1");
  mkdirSync(projectPath, { recursive: true });
  writeFileSync(join(projectPath, "package.json"), JSON.stringify({
    packageManager: "bun@1.3.11",
    devDependencies: {
      typescript: "^5.0.0",
    },
    scripts: {
      typecheck: "tsc -p tsconfig.json --noEmit",
    },
  }, null, 2), "utf8");
  writeFileSync(join(projectPath, "bun.lock"), "", "utf8");

  try {
    const result = runWorkerDependencyPreflight({ taskDir, projectPath });

    expect(result).toMatchObject({
      status: "needs_dependency_setup",
      package_manager: "bun",
      install_command: "bun install",
    });
    expect(result.findings.join("\n")).toContain("node_modules is missing");
    expect(result.findings.join("\n")).toContain("node_modules/.bin/tsc is missing");
    expect(result.validation_guidance.join("\n")).toContain("before typecheck, lint, test");
    expect(existsSync(join(taskDir, "worker-preflight.json"))).toBe(true);
    expect(readFileSync(join(taskDir, "worker-preflight.md"), "utf8")).toContain("Status: needs_dependency_setup");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("worker dependency preflight passes when local validation binaries exist", () => {
  const root = tempRoot();
  const projectPath = join(root, "butler-worktree");
  mkdirSync(join(projectPath, "node_modules", ".bin"), { recursive: true });
  writeFileSync(join(projectPath, "package.json"), JSON.stringify({
    scripts: {
      typecheck: "tsc -p tsconfig.json --noEmit",
    },
    devDependencies: {
      typescript: "^5.0.0",
    },
  }, null, 2), "utf8");
  writeFileSync(join(projectPath, "node_modules", ".bin", "tsc"), "#!/bin/sh\n", "utf8");

  try {
    expect(inspectWorkerDependencyPreflight(projectPath)).toMatchObject({
      status: "ok",
      install_command: "bun install",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("worker dependency preflight is not applicable outside Node package workspaces", () => {
  const root = tempRoot();

  try {
    expect(inspectWorkerDependencyPreflight(root)).toMatchObject({
      status: "not_applicable",
      package_json_path: null,
      install_command: null,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
