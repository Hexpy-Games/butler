import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildEvidenceCapabilityLedger,
} from "../../packages/butler-agent/src/agent/output/evidence/ledger.ts";
import { executeGrepFilesTool } from "../../packages/butler-agent/src/agent/tools/file-tools/grep_files/index.ts";
import { executeReadFileTool } from "../../packages/butler-agent/src/agent/tools/file-tools/read_file/index.ts";
import { executeWriteFileTool } from "../../packages/butler-agent/src/agent/tools/file-tools/write_file/index.ts";
import { runCommandTool } from "../../packages/butler-agent/src/agent/tools/run-command/run_command/executor.ts";

let workspace = "";
let butlerData = "";

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "butler-evidence-workspace-"));
  butlerData = await mkdtemp(join(tmpdir(), "butler-evidence-data-"));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
  await rm(butlerData, { recursive: true, force: true });
});

const call = (args: Record<string, unknown>) => ({ arguments: args });

describe("run_command evidence capability receipts", () => {
  test("records successful command status without raw output or private paths", async () => {
    const result = await runCommandTool({
      butlerData,
      workspacePath: workspace,
      args: { command: "printf 'secret-token-output'", output_mode: "full" },
    });
    const receipts = result.evidence_capability_receipts as unknown[];
    const ledger = buildEvidenceCapabilityLedger({ required: ["command_executed"], receipts });

    expect(result.evidence_receipts).toBeTruthy();
    expect(ledger.satisfied).toEqual(["command_executed"]);
    expect(ledger.receipts[0]).toMatchObject({
      capability: "command_executed",
      evidence_kind: "execution_result",
      verified: true,
      scope: { status: "succeeded", exit_code: 0, timed_out: false },
    });
    expect(JSON.stringify(receipts)).not.toContain("secret-token-output");
    expect(JSON.stringify(receipts)).not.toContain(workspace);
  });

  test("records failed command exit code as rejected execution evidence", async () => {
    const result = await runCommandTool({
      butlerData,
      workspacePath: workspace,
      args: { command: "exit 7" },
    });
    const receipts = result.evidence_capability_receipts as unknown[];
    const ledger = buildEvidenceCapabilityLedger({ required: ["command_executed"], receipts });

    expect(ledger.satisfied).toEqual([]);
    expect(ledger.missing).toEqual(["command_executed"]);
    expect(ledger.receipts[0]).toMatchObject({
      capability: "command_executed",
      evidence_kind: "execution_result",
      maturity: "rejected",
      verified: false,
      scope: { status: "failed", exit_code: 7, timed_out: false },
    });
  });

  test("records timed out command as partial execution evidence", async () => {
    const result = await runCommandTool({
      butlerData,
      workspacePath: workspace,
      args: { command: "sleep 2", timeout_ms: 1000 },
    });
    const receipts = result.evidence_capability_receipts as unknown[];

    expect(receipts[0]).toMatchObject({
      capability: "command_executed",
      evidence_kind: "execution_result",
      maturity: "candidate",
      verified: false,
      scope: { status: "timed_out", exit_code: null, timed_out: true },
    });
  });

  test("records structured validation evidence without command-name inference", async () => {
    const result = await runCommandTool({
      butlerData,
      workspacePath: workspace,
      args: {
        command: "printf '%s' '{\"validation_result\":{\"suite\":\"targeted unit tests\",\"result\":\"passed\"}}'",
      },
    });
    const receipts = result.evidence_capability_receipts as Array<Record<string, unknown>>;

    expect(receipts.some((receipt) =>
      receipt.capability === "validation_passed" &&
      (receipt.scope as Record<string, unknown>).suite === "targeted unit tests" &&
      (receipt.scope as Record<string, unknown>).result === "passed",
    )).toBe(true);
  });

  test("records command artifact table and durable artifact capabilities", async () => {
    const result = await runCommandTool({
      butlerData,
      workspacePath: workspace,
      args: {
        command: "printf 'a,b\\n1,2\\n' > report.csv",
        output_paths: ["report.csv"],
      },
    });
    const receipts = result.evidence_capability_receipts as unknown[];
    const ledger = buildEvidenceCapabilityLedger({
      required: ["durable_artifact", "data_table_created"],
      receipts,
    });

    expect(ledger.satisfied).toEqual(["command_executed", "durable_artifact", "data_table_created"]);
    expect(JSON.stringify(receipts)).not.toContain(workspace);
  });

  test("records successful verified product-state side effects when output_paths are omitted", async () => {
    await runCommandTool({
      butlerData,
      workspacePath: workspace,
      args: { command: "git init >/dev/null" },
    });

    const result = await runCommandTool({
      butlerData,
      workspacePath: workspace,
      args: {
        command: "mkdir -p reports && printf 'a,b\\n1,2\\n' > reports/generated.csv",
      },
    });
    const receipts = result.evidence_capability_receipts as unknown[];
    const ledger = buildEvidenceCapabilityLedger({
      required: ["durable_artifact", "data_table_created"],
      receipts,
    });

    expect(ledger.satisfied).toEqual(["command_executed", "durable_artifact", "data_table_created"]);
    expect(result).toMatchObject({
      durable_artifact_created: true,
      written_file: "reports/generated.csv",
    });
    expect(JSON.stringify(receipts)).not.toContain(workspace);
  });

  test("does not attribute pre-existing dirty workspace files to unrelated commands", async () => {
    await runCommandTool({
      butlerData,
      workspacePath: workspace,
      args: { command: "git init >/dev/null" },
    });
    await writeFile(join(workspace, "existing.txt"), "already dirty");

    const result = await runCommandTool({
      butlerData,
      workspacePath: workspace,
      args: { command: "printf 'checked\\n'" },
    });
    const receipts = result.evidence_capability_receipts as unknown[];
    const ledger = buildEvidenceCapabilityLedger({
      required: ["durable_artifact"],
      receipts,
    });

    expect(ledger.satisfied).toEqual(["command_executed"]);
    expect(ledger.missing).toEqual(["durable_artifact"]);
    expect(result).not.toHaveProperty("durable_artifact_created");
  });
});

describe("file tool evidence capability receipts", () => {
  test("records write mutations with path metadata and no file content", async () => {
    const result = await executeWriteFileTool(call({
      workspace_root: workspace,
      path: "notes/secret.txt",
      content: "do-not-leak-content",
      create_parents: true,
    }));
    const receipts = (result as Record<string, unknown>).evidence_capability_receipts as unknown[];

    expect((result as Record<string, unknown>).evidence_receipts).toBeTruthy();
    expect(receipts[0]).toMatchObject({
      capability: "workspace_mutated",
      evidence_kind: "mutation_result",
      verified: true,
      references: [{ path: "notes/secret.txt" }],
      scope: { operation: "created", created: true, overwritten: false },
    });
    expect(JSON.stringify(receipts)).not.toContain("do-not-leak-content");
    expect(JSON.stringify(receipts)).not.toContain(workspace);
    expect(buildEvidenceCapabilityLedger({
      required: ["durable_artifact"],
      receipts,
    }).satisfied).toEqual(["durable_artifact"]);
  });

  test("records partial read receipts for truncated file inspection", async () => {
    await writeFile(join(workspace, "long.txt"), "abcdef");
    const result = await executeReadFileTool(call({
      workspace_root: workspace,
      path: "long.txt",
      max_bytes: 3,
    }));
    const receipts = (result as Record<string, unknown>).evidence_capability_receipts as unknown[];
    const ledger = buildEvidenceCapabilityLedger({ required: ["source_verified"], receipts });

    expect(ledger.satisfied).toEqual(["source_verified"]);
    expect(receipts[0]).toMatchObject({
      capability: "source_verified",
      evidence_kind: "workspace_inspection",
      verified: true,
      references: [{ path: "long.txt" }],
      scope: { truncated: true, bytes: 6 },
      limitations: ["Result was bounded and may be partial."],
    });
    expect(JSON.stringify(receipts)).not.toContain("abc");
  });

  test("records skipped file receipts without unsafe paths", async () => {
    const result = await executeReadFileTool(call({
      workspace_root: workspace,
      path: "../private.txt",
    }));
    const receipts = (result as Record<string, unknown>).evidence_capability_receipts as unknown[];
    const ledger = buildEvidenceCapabilityLedger({ required: ["source_verified"], receipts });

    expect(ledger.satisfied).toEqual([]);
    expect(receipts[0]).toMatchObject({
      capability: "limitation_recorded",
      evidence_kind: "limitation",
      maturity: "rejected",
      verified: false,
      references: [],
    });
    expect(JSON.stringify(receipts)).not.toContain("../private.txt");
    expect(JSON.stringify(receipts)).not.toContain(workspace);
  });

  test("records grep partial receipts from structured search outcome", async () => {
    await mkdir(join(workspace, "src"));
    await writeFile(join(workspace, "src/a.txt"), "needle\nneedle\n");
    const result = await executeGrepFilesTool(call({
      workspace_root: workspace,
      query: "needle",
      max_matches: 1,
    }));
    const receipts = (result as Record<string, unknown>).evidence_capability_receipts as unknown[];

    expect(receipts[0]).toMatchObject({
      capability: "source_verified",
      evidence_kind: "workspace_inspection",
      verified: true,
      scope: { truncated: true, match_count: 1 },
      limitations: ["Result was bounded and may be partial."],
    });
    expect(JSON.stringify(receipts)).not.toContain("needle");
  });
});
