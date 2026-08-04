import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveGitWorkspaceSummary } from
  "../../packages/butler-agent/src/gateways/app/domain/sessions/index.ts";

test("Git summary reports a detached worktree without inventing a branch", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-git-detached-"));
  try {
    mkdirSync(join(root, "workspace"));
    const workspace = join(root, "workspace");
    const git = process.env.BUTLER_GIT_EXECUTABLE?.trim() || "git";
    const init = spawnSync(git, ["init"], { cwd: workspace, encoding: "utf8" });
    expect(init.status).toBe(0);
    const commit = spawnSync(
      git,
      [
        "-c",
        "user.email=butler-tests@example.invalid",
        "-c",
        "user.name=Butler Tests",
        "commit",
        "--allow-empty",
        "-m",
        "test",
      ],
      { cwd: workspace, encoding: "utf8" },
    );
    expect(commit.status).toBe(0);
    const detach = spawnSync(git, ["checkout", "--detach"], {
      cwd: workspace,
      encoding: "utf8",
    });
    expect(detach.status).toBe(0);

    expect(resolveGitWorkspaceSummary(workspace, git)).toEqual({
      available: true,
      workspace_mode: "git",
      safe_status: "Detached HEAD",
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
