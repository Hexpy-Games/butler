import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeReadFileTool } from "../../packages/butler-agent/src/agent/tools/file-tools/read_file/executor.ts";
import { executeWriteFileTool } from "../../packages/butler-agent/src/agent/tools/file-tools/write_file/executor.ts";
import { executeGrepFilesTool } from "../../packages/butler-agent/src/agent/tools/file-tools/grep_files/executor.ts";

async function tmpWorkspace() {
  return mkdtemp(join(tmpdir(), "butler-file-tools-"));
}

describe("native file tools hardening", () => {
  test("returns structured errors for malformed JSON tool arguments", async () => {
    const workspace = await tmpWorkspace();
    for (const execute of [executeReadFileTool, executeWriteFileTool, executeGrepFilesTool]) {
      const result = await execute({ arguments: '{"path":"almost"' }, { workspacePath: workspace }) as { ok: false; error: string };
      expect(result.ok).toBe(false);
      expect(result.error).toBe("invalid_arguments_json");
    }
  });

  test("write_file requires explicit parent creation", async () => {
    const workspace = await tmpWorkspace();
    const withoutParents = await executeWriteFileTool({ arguments: { path: "nested/file.txt", content: "hello" } }, { workspacePath: workspace }) as { ok: false; error: string };
    expect(withoutParents.ok).toBe(false);
    expect(withoutParents.error).toBe("parent_directory_missing");

    const withParents = await executeWriteFileTool({ arguments: { path: "nested/file.txt", content: "hello", create_parents: true } }, { workspacePath: workspace }) as { ok: true; create_parents: boolean };
    expect(withParents.ok).toBe(true);
    expect(withParents.create_parents).toBe(true);
    expect(await readFile(join(workspace, "nested/file.txt"), "utf8")).toBe("hello");
  });

  test("write_file does not treat expected sha on missing file as a successful create", async () => {
    const workspace = await tmpWorkspace();
    const result = await executeWriteFileTool({ arguments: { path: "missing.txt", content: "new", expected_sha256: "abc" } }, { workspacePath: workspace }) as { ok: false; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toBe("expected_sha256_on_missing_file");
  });

  test("read_file byte truncation preserves UTF-8 boundaries", async () => {
    const workspace = await tmpWorkspace();
    await writeFile(join(workspace, "utf8.txt"), "한🙂글", "utf8");
    const result = await executeReadFileTool({ arguments: { path: "utf8.txt", max_bytes: 4 } }, { workspacePath: workspace }) as { ok: true; content: string; byte_truncated: boolean };
    expect(result.ok).toBe(true);
    expect(result.byte_truncated).toBe(true);
    expect(result.content).toBe("한");
    expect(result.content.includes("�")).toBe(false);
  });

  test("grep_files reports traversal caps as partial results", async () => {
    const workspace = await tmpWorkspace();
    await mkdir(join(workspace, "a", "b"), { recursive: true });
    await writeFile(join(workspace, "a", "b", "hit.txt"), "needle", "utf8");
    const result = await executeGrepFilesTool({ arguments: { pattern: "needle", max_dirs: 1 } }, { workspacePath: workspace }) as { ok: true; truncated: boolean; stopped_by?: string };
    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.stopped_by).toBe("max_dirs");
  });

  test("evidence receipts distinguish read, write, and search operations", async () => {
    const workspace = await tmpWorkspace();
    await writeFile(join(workspace, "file.txt"), "needle", "utf8");
    const readResult = await executeReadFileTool({ arguments: { path: "file.txt" } }, { workspacePath: workspace }) as { evidence_receipts: Array<{ covers: string[] }> };
    const writeResult = await executeWriteFileTool({ arguments: { path: "out.txt", content: "ok" } }, { workspacePath: workspace }) as { evidence_receipts: Array<{ covers: string[] }> };
    const grepResult = await executeGrepFilesTool({ arguments: { pattern: "needle" } }, { workspacePath: workspace }) as { evidence_receipts: Array<{ covers: string[] }> };
    expect(readResult.evidence_receipts[0].covers).toContain("workspace_file_read");
    expect(writeResult.evidence_receipts[0].covers).toContain("workspace_file_written");
    expect(grepResult.evidence_receipts[0].covers).toContain("workspace_search_result");
  });
});
