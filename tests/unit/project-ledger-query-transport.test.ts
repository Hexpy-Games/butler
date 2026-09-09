import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { commandForProjectLedgerNativeTool } from "../../packages/butler-agent/src/agent/tools/project-ledger/command.ts";
import { runProjectLedgerTool } from "../../packages/butler-agent/src/integrations/project-ledger/client.ts";

test("list filters before serialization: a multi-megabyte index fits the native transport", () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-query-transport-"));
  const root = join(dir, "project-ledger/projects/demo");
  mkdirSync(join(root, "index"), { recursive: true });
  writeFileSync(join(root, "project.json"), JSON.stringify({ id: "demo", name: "Demo" }));
  const records = Array.from({ length: 12000 }, (_, i) => ({ id: `W-${i}`, kind: "work", title: i > 11989 ? `OAuth ${i}` : "Unrelated ".repeat(30),
    status: i % 2 ? "done" : "blocked", path: `project-ledger/projects/demo/work/W-${i}/work.md` }));
  writeFileSync(join(root, "index/project.json"), JSON.stringify({ schema: "project-ledger.index.v1", project: { id: "demo" }, records }));
  try {
    const args = commandForProjectLedgerNativeTool("project_ledger_list", { kind: "work", status: "blocked", query: "OAuth", limit: 3 }, root);
    expect(args).toContain("--limit");
    const result = runProjectLedgerTool({ butlerHome: process.cwd(), butlerData: dir }, args) as any;
    expect(result.ok).toBe(true);
    expect(result.data.results).toHaveLength(3);
    expect(result.data.total).toBe(5);
    expect(result.data.truncated).toBe(true);
    expect(result.data.results.every((r: any) => r.title.includes("OAuth") && r.status === "blocked")).toBe(true);
    const unbounded = runProjectLedgerTool({ butlerHome: process.cwd(), butlerData: dir }, ["query", "--project", root, "--kind", "all"]) as any;
    expect(unbounded.error.code).toBe("project_ledger_output_limit");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
