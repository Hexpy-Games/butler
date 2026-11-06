import { dirname, isAbsolute, posix, resolve } from "node:path";

/** A tracked symlink is accidental when it leaves the repo or points into a worktree. */
export function symlinkProblem(linkPath: string, target: string): string | null {
  if (target.includes(".claude/worktrees")) return "points into .claude/worktrees";
  if (isAbsolute(target)) return "absolute target";
  const resolved = posix.normalize(posix.join(dirname(linkPath), target));
  if (resolved === ".." || resolved.startsWith("../")) return "points outside the repository";
  return null;
}

const ROOT = resolve(import.meta.dir, "../../../..");

/** Reads git's whole stdout as a stream, so no capture limit can cut it short. */
async function git(args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed (exit ${code}): ${stderr}`);
  return stdout;
}

if (import.meta.main) {
  const problems: string[] = [];
  for (const line of (await git(["ls-files", "-s"])).split("\n")) {
    const match = /^120000 (\w+) \d\t(.+)$/.exec(line);
    if (!match) continue;
    const target = await git(["cat-file", "blob", match[1]!]);
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
