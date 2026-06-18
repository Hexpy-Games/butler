import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sha256Hex } from "../../packages/butler-agent/src/agent/tools/file-tools/shared/evidence.ts";
import { resolveWorkspacePathGuard } from "../../packages/butler-agent/src/agent/tools/file-tools/shared/workspace-path-guard.ts";
import { executeReadFileTool } from "../../packages/butler-agent/src/agent/tools/file-tools/read_file/index.ts";
import { executeWriteFileTool } from "../../packages/butler-agent/src/agent/tools/file-tools/write_file/index.ts";
import { executeGrepFilesTool } from "../../packages/butler-agent/src/agent/tools/file-tools/grep_files/index.ts";

let root = "";
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "butler-file-tools-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const call = (a: Record<string, unknown>) => ({ name: "test", arguments: a });

describe("workspace path guard", () => {
  test("allows in-workspace files and blocks traversal, sensitive paths, and symlink escape", async () => {
    await writeFile(join(root, "ok.txt"), "ok");
    expect((await resolveWorkspacePathGuard({ workspaceRoot: root, relativePath: "ok.txt" })).ok).toBe(true);
    expect((await resolveWorkspacePathGuard({ workspaceRoot: root, relativePath: "../x" })).reason).toBe("parent_traversal_not_allowed");
    expect((await resolveWorkspacePathGuard({ workspaceRoot: root, relativePath: "config/models/chatgpt-oauth.json", allowMissingLeaf: true })).reason).toBe("sensitive_path_blocked");
    await symlink(tmpdir(), join(root, "escape"));
    expect((await resolveWorkspacePathGuard({ workspaceRoot: root, relativePath: "escape" })).reason).toBe("symlink_escape");
  });
});

describe("read_file", () => {
  test("reads bounded text with truncation and rejects binary", async () => {
    await writeFile(join(root, "a.txt"), "abcdef");
    const res = await executeReadFileTool(call({ workspace_root: root, path: "a.txt", max_bytes: 3 })) as any;
    expect(res.ok).toBe(true); expect(res.content).toBe("abc"); expect(res.truncated).toBe(true); expect(res.evidence_receipts[0].verified).toBe(true);
    await writeFile(join(root, "lines.txt"), "one\ntwo\nthree\nfour");
    const lineRes = await executeReadFileTool(call({ workspace_root: root, path: "lines.txt", start_line: 2, limit_lines: 2 })) as any;
    expect(lineRes.content).toBe("two\nthree"); expect(lineRes.start_line).toBe(2); expect(lineRes.end_line).toBe(3); expect(lineRes.truncated).toBe(true);
    await writeFile(join(root, "bin.dat"), Buffer.from([1,0,2]));
    expect(((await executeReadFileTool(call({ workspace_root: root, path: "bin.dat" }))) as any).error).toBe("binary_file_not_supported");
  });
});

describe("write_file", () => {
  test("creates, overwrites with expected_sha256, rejects stale guard", async () => {
    const created = await executeWriteFileTool(call({ workspace_root: root, path: "dir/a.txt", content: "one" })) as any;
    expect(created.ok).toBe(true); expect(created.created).toBe(true); expect(await readFile(join(root,"dir/a.txt"),"utf8")).toBe("one");
    const stale = await executeWriteFileTool(call({ workspace_root: root, path: "dir/a.txt", content: "two", overwrite: true, expected_sha256: "bad" })) as any;
    expect(stale.error).toBe("expected_sha256_mismatch");
    const good = await executeWriteFileTool(call({ workspace_root: root, path: "dir/a.txt", content: "two", overwrite: true, expected_sha256: sha256Hex("one") })) as any;
    expect(good.ok).toBe(true); expect(good.atomic_write).toBe(true); expect(good.after_sha256).toBe(sha256Hex("two"));
  });
});

describe("grep_files", () => {
  test("supports include, exclude, context, truncation, and receipts", async () => {
    await mkdir(join(root,"src")); await writeFile(join(root,"src/a.ts"), "before\nneedle\nafter\n"); await writeFile(join(root,"src/a.md"), "needle\n");
    const res = await executeGrepFilesTool(call({ workspace_root: root, query: "NEEDLE", case_sensitive: false, include_globs:["src/*.ts"], exclude_globs:["**/*.md"], context_lines:1, max_matches:1 })) as any;
    expect(res.ok).toBe(true); expect(res.matches).toHaveLength(1); expect(res.matches[0].context).toHaveLength(3); expect(res.truncated).toBe(true); expect(res.evidence_receipts[0].producer.name).toBe("grep_files");
  });
});
