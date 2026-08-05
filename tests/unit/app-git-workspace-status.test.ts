import { expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveGitWorkspaceSummary } from
  "../../packages/butler-agent/src/gateways/app/domain/sessions/index.ts";

test("Git workspace status reports a missing executable without throwing", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-git-status-"));
  try {
    const workspace = join(root, "workspace");
    mkdirSync(workspace);

    expect(resolveGitWorkspaceSummary(
      workspace,
      join(root, "missing-git-executable"),
    )).toEqual({
      available: false,
      workspace_mode: "unknown",
      safe_status: "Git is not installed",
      safe_error_code: "git_not_installed",
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("Git workspace status does not warn for an installed non-Git folder", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-git-status-"));
  try {
    expect(resolveGitWorkspaceSummary(root, process.execPath)).toEqual({
      available: false,
      workspace_mode: "folder",
      safe_status: "Project workspace",
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("Git workspace status keeps a missing workspace distinct from missing Git", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-git-status-"));
  try {
    expect(resolveGitWorkspaceSummary(
      join(root, "missing-workspace"),
      join(root, "missing-git-executable"),
    )).toEqual({
      available: false,
      workspace_mode: "unknown",
      safe_status: "Project workspace unavailable",
      safe_error_code: "git_workspace_unavailable",
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("Git workspace status reports a branch probe failure as unavailable", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-git-status-"));
  try {
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const git = writeGitProbeStub(root, "exit 23");

    expect(resolveGitWorkspaceSummary(workspace, git)).toEqual({
      available: false,
      workspace_mode: "unknown",
      safe_status: "Git workspace unavailable",
      safe_error_code: "git_workspace_unavailable",
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("Git workspace status reports a timed-out branch probe as unavailable", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-git-status-"));
  try {
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const git = writeGitProbeStub(root, "sleep 2");

    expect(resolveGitWorkspaceSummary(workspace, git)).toEqual({
      available: false,
      workspace_mode: "unknown",
      safe_status: "Git workspace unavailable",
      safe_error_code: "git_workspace_unavailable",
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

function writeGitProbeStub(root: string, branchCommand: string): string {
  const executable = join(root, "git-probe-stub");
  writeFileSync(
    executable,
    `#!/bin/sh
case "$1" in
  --version) printf 'git version test\\n' ;;
  rev-parse) printf 'true\\n' ;;
  branch) ${branchCommand} ;;
esac
`,
  );
  chmodSync(executable, 0o755);
  return executable;
}
