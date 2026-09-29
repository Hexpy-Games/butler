import { describe, expect, test } from "bun:test";
import { symlinkProblem } from "../../packages/butler-app/scripts/lint/tracked-symlink-lint.ts";

describe("tracked symlink lint", () => {
  // test-category: pure-logic
  test("flags targets outside the repo or inside agent worktrees, allows in-repo links", () => {
    expect(symlinkProblem("a/b/node_modules", "/Users/x/butler/.claude/worktrees/agent-1/a/node_modules")).not.toBeNull();
    expect(symlinkProblem("a/b/link", "/etc/passwd")).not.toBeNull();
    expect(symlinkProblem("a/b/link", "../../../x")).not.toBeNull();
    expect(symlinkProblem("a/b/link", "../c/file")).toBeNull();
    expect(symlinkProblem("a/link", "sibling")).toBeNull();
  });
});
