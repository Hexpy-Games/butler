import { expect, test } from "bun:test";
import { existsSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";

const root = process.cwd();
const cliPath = join(root, "packages", "project-ledger", "bin", "project-ledger");

function runLedgerJson(args: string[]): any {
  const result = spawnSync(process.execPath, [cliPath, ...args, "--project", root, "--json"], {
    encoding: "utf8",
  });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout);
}

test("Butler repo dogfoods Project Ledger with generated bounded views", () => {
  expect(existsSync(join(root, ".project-ledger", "project.json"))).toBe(true);
  expect(existsSync(join(root, ".project-ledger", "views", "dashboard.md"))).toBe(true);
  expect(existsSync(join(root, ".project-ledger", "views", "handoff.md"))).toBe(true);
  expect(existsSync(join(root, ".project-ledger", "views", "roadmap.md"))).toBe(true);

  const status = runLedgerJson(["status"]);
  expect(status.data.project.id).toBe("butler");
  expect(status.data.counts.work).toBeGreaterThanOrEqual(6);
  expect(status.data.index.stale).toBe(false);
  expect(status.data.staleViews).toEqual([]);

  const check = runLedgerJson(["check"]);
  expect(check.ok).toBe(true);
  expect(check.data.issueCount).toBe(0);
});
