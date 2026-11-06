import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, posix, resolve } from "node:path";

/** A tracked symlink is accidental when it leaves the repo or points into a worktree. */
export function symlinkProblem(linkPath: string, target: string): string | null {
  if (target.includes(".claude/worktrees")) return "points into .claude/worktrees";
  if (isAbsolute(target)) return "absolute target";
  const resolved = posix.normalize(posix.join(dirname(linkPath), target));
  if (resolved === ".." || resolved.startsWith("../")) return "points outside the repository";
  return null;
}

function git(args: string[]): string {
  // `git ls-files -s` outgrew spawnSync's ~1 MiB default buffer (ENOBUFS on Linux).
  const result = spawnSync("git", args, { cwd: resolve(import.meta.dir, "../../../.."), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0 || result.error) throw new Error(`git ${args.join(" ")} failed: ${result.error ?? result.stderr}`);
  return result.stdout;
}

if (import.meta.main) {
  const problems: string[] = [];
  for (const line of git(["ls-files", "-s"]).split("\n")) {
    const match = /^120000 (\w+) \d\t(.+)$/.exec(line);
    if (!match) continue;
    const target = git(["cat-file", "blob", match[1]!]);
    const problem = symlinkProblem(match[2]!, target);
    if (problem) problems.push(`${match[2]} -> ${target}: ${problem}`);
  }
  if (problems.length > 0) {
    console.error("Tracked symlink lint failed:");
    for (const problem of problems) console.error(`  ${problem}`);
    console.error("Remove with `git rm --cached` and add the path to .gitignore.");
    process.exit(1);
  }
}
