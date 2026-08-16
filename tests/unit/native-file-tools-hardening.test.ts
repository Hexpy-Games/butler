import { describe, expect, test } from "bun:test";
import { access, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeReadFileTool } from "../../packages/butler-agent/src/agent/tools/file-tools/read_file/executor.ts";
import { executeWriteFileTool } from "../../packages/butler-agent/src/agent/tools/file-tools/write_file/executor.ts";
import { writeFileToolDefinition } from "../../packages/butler-agent/src/agent/tools/file-tools/write_file/definition.ts";
import { executeGrepFilesTool } from "../../packages/butler-agent/src/agent/tools/file-tools/grep_files/executor.ts";

async function tmpWorkspace() {
  return mkdtemp(join(tmpdir(), "butler-file-tools-"));
}

describe("native file tools hardening", () => {
  test("write_file advertises the canonical SHA-256 guard pattern", () => {
    const parameters = writeFileToolDefinition.parameters as { properties: Record<string, { pattern?: string }> };
    expect(parameters.properties.expected_sha256.pattern).toBe("^[a-fA-F0-9]{64}$");
  });

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

  test("write_file requires a current expected hash for replacement and keeps creation explicit", async () => {
    const workspace = await tmpWorkspace();
    await writeFile(join(workspace, "existing.txt"), "old", "utf8");
    const missingGuard = await executeWriteFileTool({ arguments: {
      path: "existing.txt",
      content: "new",
      overwrite: true,
    } }, { workspacePath: workspace }) as { ok: false; error: string };
    expect(missingGuard.error).toBe("expected_sha256_required");
    const accidentalCreate = await executeWriteFileTool({ arguments: {
      path: "new.txt",
      content: "new",
      overwrite: true,
    } }, { workspacePath: workspace }) as { ok: false; error: string };
    expect(accidentalCreate.error).toBe("invalid_arguments");
    expect(await readFile(join(workspace, "existing.txt"), "utf8")).toBe("old");
    await expect(access(join(workspace, "new.txt"))).rejects.toBeDefined();
  });

  test("write_file does not treat expected sha on missing file as a successful create", async () => {
    const workspace = await tmpWorkspace();
    const result = await executeWriteFileTool({ arguments: { path: "missing.txt", content: "new", expected_sha256: "a".repeat(64) } }, { workspacePath: workspace }) as { ok: false; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toBe("expected_sha256_on_missing_file");
  });

  test("rejected write preflight never creates requested parents", async () => {
    const workspace = await tmpWorkspace();
    const rejectedOverwrite = await executeWriteFileTool({ arguments: {
      path: "rejected/overwrite.txt",
      content: "new",
      overwrite: true,
      create_parents: true,
    } }, { workspacePath: workspace }) as { ok: false; error: string };
    expect(rejectedOverwrite.error).toBe("invalid_arguments");
    await expect(access(join(workspace, "rejected"))).rejects.toBeDefined();

    const rejectedExpectedSha = await executeWriteFileTool({ arguments: {
      path: "rejected-sha/file.txt",
      content: "new",
      overwrite: false,
      expected_sha256: "f".repeat(64),
      create_parents: true,
    } }, { workspacePath: workspace }) as { ok: false; error: string };
    expect(rejectedExpectedSha.error).toBe("expected_sha256_on_missing_file");
    await expect(access(join(workspace, "rejected-sha"))).rejects.toBeDefined();

    const invalid = await executeWriteFileTool({ arguments: {
      path: "",
      content: "new",
      overwrite: false,
      create_parents: true,
    } }, { workspacePath: workspace }) as { ok: false; error: string };
    expect(invalid.error).toBe("invalid_arguments");
    expect(JSON.stringify(invalid)).not.toContain(workspace);
  });

  test("write_file invalid path/content/overwrite inputs are typed invalid_arguments", async () => {
    const workspace = await tmpWorkspace();
    const omittedOverwrite = await executeWriteFileTool({ arguments: {
      path: "omitted-overwrite.txt",
      content: "new",
    } }, { workspacePath: workspace }) as { ok: true; created: boolean };
    expect(omittedOverwrite.created).toBe(true);
    const invalidOverwrite = await executeWriteFileTool({ arguments: {
      path: "invalid-overwrite.txt",
      content: "new",
      overwrite: "false",
    } }, { workspacePath: workspace }) as { ok: false; error: string };
    expect(invalidOverwrite.error).toBe("invalid_arguments");
    const invalidContent = await executeWriteFileTool({ arguments: {
      path: "invalid-content.txt",
      content: 42,
      overwrite: false,
    } }, { workspacePath: workspace }) as { ok: false; error: string };
    expect(invalidContent.error).toBe("invalid_arguments");
    const invalidSha = await executeWriteFileTool({ arguments: {
      path: "invalid-sha.txt",
      content: "new",
      overwrite: false,
      expected_sha256: "not-a-sha",
    } }, { workspacePath: workspace }) as { ok: false; error: string };
    expect(invalidSha.error).toBe("invalid_arguments");
  });

  test("write_file normalizes uppercase SHA-256 replacement guards", async () => {
    const workspace = await tmpWorkspace();
    await writeFile(join(workspace, "uppercase.txt"), "old", "utf8");
    const result = await executeWriteFileTool({ arguments: {
      path: "uppercase.txt",
      content: "new",
      overwrite: true,
      expected_sha256: "c".repeat(64).toUpperCase(),
    } }, { workspacePath: workspace }) as { ok: false; error: string };
    expect(result.error).toBe("expected_sha256_mismatch");
    const actual = await import("../../packages/butler-agent/src/agent/tools/file-tools/shared/evidence.ts").then(({ sha256Hex }) => sha256Hex("old"));
    const success = await executeWriteFileTool({ arguments: {
      path: "uppercase.txt",
      content: "new",
      overwrite: true,
      expected_sha256: actual.toUpperCase(),
    } }, { workspacePath: workspace }) as { ok: true; overwritten: boolean };
    expect(success.overwritten).toBe(true);
    expect(await readFile(join(workspace, "uppercase.txt"), "utf8")).toBe("new");
  });

  test("rejected absolute write paths are not exposed in result or evidence", async () => {
    const workspace = await tmpWorkspace();
    const outside = await tmpWorkspace();
    const absolutePath = join(outside, "secret.txt");
    const result = await executeWriteFileTool({ arguments: {
      path: absolutePath,
      content: "secret",
      overwrite: false,
      create_parents: true,
    } }, { workspacePath: workspace }) as { ok: false; error: string };
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(absolutePath);
    expect(JSON.stringify(result)).not.toContain(outside);
    await expect(access(absolutePath)).rejects.toBeDefined();
  });

  test("read_file byte truncation preserves UTF-8 boundaries", async () => {
    const workspace = await tmpWorkspace();
    await writeFile(join(workspace, "utf8.txt"), "한🙂글", "utf8");
    const result = await executeReadFileTool({ arguments: { requests: [{ path: "utf8.txt", max_bytes: 4 }] } }, { workspacePath: workspace }) as { ok: true; files: Array<{ content: string; byte_truncated: boolean }> };
    expect(result.ok).toBe(true);
    expect(result.files[0]!.byte_truncated).toBe(true);
    expect(result.files[0]!.content).toBe("한");
    expect(result.files[0]!.content.includes("�")).toBe(false);
  });

  test("trusted session workspace overrides a model-supplied workspace root", async () => {
    const workspace = await tmpWorkspace();
    await writeFile(join(workspace, "owned.txt"), "runtime-owned workspace", "utf8");

    const result = await executeReadFileTool({
      arguments: {
        workspace_root: "/",
        requests: [{ path: "owned.txt" }],
      },
    }, { workspacePath: workspace }) as { ok: boolean; files: Array<{ content?: string }> };

    expect(result.ok).toBe(true);
    expect(result.files[0]!.content).toContain("runtime-owned workspace");
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

  test("grep_files excludes temporary roots and preserves source-priority results", async () => {
    const workspace = await tmpWorkspace();
    await mkdir(join(workspace, ".tmp", "generated"), { recursive: true });
    await mkdir(join(workspace, "packages", "feature", "src"), { recursive: true });
    await mkdir(join(workspace, "packages", "feature", "scripts", "fixtures"), { recursive: true });
    await mkdir(join(workspace, "tests"), { recursive: true });
    await writeFile(join(workspace, ".tmp", "generated", "cache.ts"), "prompt_cache_key", "utf8");
    await writeFile(join(workspace, "tests", "cache.test.ts"), "prompt_cache_key", "utf8");
    await writeFile(join(workspace, "packages", "feature", "scripts", "fixtures", "cache.ts"), "prompt_cache_key", "utf8");
    await writeFile(join(workspace, "packages", "feature", "src", "cache.ts"), "prompt_cache_key", "utf8");

    const result = await executeGrepFilesTool({
      arguments: { pattern: "prompt_cache_key", max_matches: 1 },
    }, { workspacePath: workspace }) as {
      matches: Array<{ path: string }>;
      files_considered: number;
    };

    expect(result.matches.map((match) => match.path)).toEqual([
      "packages/feature/src/cache.ts",
    ]);
    expect(result.files_considered).toBe(3);
  });

  test("evidence receipts distinguish read, write, and search operations", async () => {
    const workspace = await tmpWorkspace();
    await writeFile(join(workspace, "file.txt"), "needle", "utf8");
    const readResult = await executeReadFileTool({ arguments: { requests: [{ path: "file.txt" }] } }, { workspacePath: workspace }) as unknown as { evidence_receipts: Array<{ covers: string[] }> };
    const writeResult = await executeWriteFileTool({ arguments: { path: "out.txt", content: "ok" } }, { workspacePath: workspace }) as { evidence_receipts: Array<{ covers: string[] }> };
    const grepResult = await executeGrepFilesTool({ arguments: { pattern: "needle" } }, { workspacePath: workspace }) as { evidence_receipts: Array<{ covers: string[] }> };
    expect(readResult.evidence_receipts[0].covers).toContain("workspace_file_read");
    expect(writeResult.evidence_receipts[0].covers).toContain("workspace_file_written");
    expect(grepResult.evidence_receipts[0].covers).toContain("workspace_search_result");
  });
});
