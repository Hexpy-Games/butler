import { describe, expect, test } from "bun:test";

import {
  configureGitHooks,
  type GitCommandRunner,
} from "../../tools/configure-git-hooks.ts";

describe("configureGitHooks", () => {
  test("configures the repository hooks path without a shell", () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const run: GitCommandRunner = (command, args) => {
      calls.push({ command, args });
      return { status: 0 };
    };

    expect(configureGitHooks(run)).toBe(true);
    expect(calls).toEqual([
      { command: "git", args: ["rev-parse", "--git-dir"] },
      { command: "git", args: ["config", "core.hooksPath", ".githooks"] },
    ]);
  });

  test("quietly skips hook setup outside a Git repository", () => {
    const calls: string[][] = [];
    const run: GitCommandRunner = (_command, args) => {
      calls.push(args);
      return { status: 128 };
    };

    expect(configureGitHooks(run)).toBe(false);
    expect(calls).toEqual([["rev-parse", "--git-dir"]]);
  });

  test("does not fail installation when Git is unavailable", () => {
    const run: GitCommandRunner = () => ({ status: null, error: new Error("ENOENT") });

    expect(configureGitHooks(run)).toBe(false);
  });
});
