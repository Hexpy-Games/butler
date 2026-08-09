import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sha256Hex } from "../../packages/butler-agent/src/agent/tools/file-tools/shared/evidence.ts";
import { projectLedgerProtectedPath } from "../../packages/butler-agent/src/agent/tools/file-tools/shared/project-ledger-protection.ts";
import { resolveWorkspacePathGuard } from "../../packages/butler-agent/src/agent/tools/file-tools/shared/workspace-path-guard.ts";
import { decodeFileToolCursor, encodeFileToolCursor } from "../../packages/butler-agent/src/agent/tools/file-tools/shared/cursor.ts";
import { executeReadFileTool } from "../../packages/butler-agent/src/agent/tools/file-tools/read_file/index.ts";
import { executeWriteFileTool } from "../../packages/butler-agent/src/agent/tools/file-tools/write_file/index.ts";
import {
  executeGrepFilesTool,
  grepFilesToolDefinition,
} from "../../packages/butler-agent/src/agent/tools/file-tools/grep_files/index.ts";
import { readCandidate } from "../../packages/butler-agent/src/agent/tools/file-tools/grep_files/grep-search.ts";
import {
  executeListFilesTool,
  listFilesToolDefinition,
} from "../../packages/butler-agent/src/agent/tools/file-tools/list_files/index.ts";
import { createFileToolHandlers } from "../../packages/butler-agent/src/agent/tools/file-tools/index.ts";

let root = "";
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "butler-file-tools-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const call = (a: Record<string, unknown>) => ({ name: "test", arguments: a });

describe("workspace path guard", () => {
  test("allows in-workspace files and blocks traversal, sensitive paths, and symlink escape", async () => {
    await writeFile(join(root, "ok.txt"), "ok");
    expect((await resolveWorkspacePathGuard({ workspaceRoot: root, relativePath: "ok.txt" })).ok).toBe(true);
    expect((await resolveWorkspacePathGuard({ workspaceRoot: root, relativePath: join(root, "ok.txt") })).ok).toBe(true);
    expect((await resolveWorkspacePathGuard({ workspaceRoot: root, relativePath: join(tmpdir(), "outside.txt") })).reason).toBe("path_escape");
    expect((await resolveWorkspacePathGuard({ workspaceRoot: root, relativePath: "../x" })).reason).toBe("parent_traversal_not_allowed");
    expect((await resolveWorkspacePathGuard({ workspaceRoot: root, relativePath: "config/models/chatgpt-oauth.json", allowMissingLeaf: true })).reason).toBe("sensitive_path_blocked");
    await symlink(tmpdir(), join(root, "escape"));
    expect((await resolveWorkspacePathGuard({ workspaceRoot: root, relativePath: "escape" })).reason).toBe("symlink_escape");
    await mkdir(join(root, "real"));
    await symlink("real", join(root, "alias"));
    const missing = await resolveWorkspacePathGuard({
      workspaceRoot: root,
      relativePath: "alias/new.txt",
      allowMissingLeaf: true,
    });
    expect(missing.realPath).toBe(join(await realpath(join(root, "real")), "new.txt"));
  });
});

describe("read_file", () => {
  test("reads bounded text with truncation and rejects binary", async () => {
    await writeFile(join(root, "a.txt"), "abcdef");
    const res = await executeReadFileTool(call({ workspace_root: root, path: "a.txt", max_bytes: 3 })) as any;
    expect(res.ok).toBe(true); expect(res.content).toBe("abc"); expect(res.truncated).toBe(true); expect(res.evidence_receipts[0].verified).toBe(true);
    expect(res.metrics.bytes_read).toBe(6);
    expect(res.metrics.output_bytes).toBe(3);
    await writeFile(join(root, "lines.txt"), "one\ntwo\nthree\nfour");
    const lineRes = await executeReadFileTool(call({ workspace_root: root, path: "lines.txt", start_line: 2, limit_lines: 2 })) as any;
    expect(lineRes.content).toBe("two\nthree"); expect(lineRes.start_line).toBe(2); expect(lineRes.end_line).toBe(3); expect(lineRes.truncated).toBe(true);
    await writeFile(join(root, "bin.dat"), Buffer.from([1, 0, 2]));
    expect(((await executeReadFileTool(call({ workspace_root: root, path: "bin.dat" }))) as any).error).toBe("binary_file_not_supported");
    expect(((await executeReadFileTool(call({ workspace_root: root, path: join(root, "a.txt") }))) as any).content).toBe("abcdef");
  });

  test("rejects Project Ledger inspection through read_file", async () => {
    await mkdir(join(root, ".project-ledger", "specs"), { recursive: true });
    await writeFile(join(root, ".project-ledger", "specs", "feature.md"), "# Feature\n", "utf8");
    const res = await executeReadFileTool(call({ workspace_root: root, path: ".project-ledger/specs/feature.md" })) as any;
    expect(res.ok).toBe(false);
    expect(res.error).toBe("protected_path");
  });

  test("reads canonical requests in order with aggregate continuation and stale cursor guard", async () => {
    await writeFile(join(root, "one.txt"), "one\ntwo\nthree\n", "utf8");
    await writeFile(join(root, "two.txt"), "four\nfive\n", "utf8");
    const first = await executeReadFileTool(call({
      workspace_root: root,
      requests: [{ path: "one.txt" }, { path: "two.txt" }],
      max_total_bytes: 5,
    })) as any;
    expect(first.ok).toBe(true);
    expect(first.files.map((file: any) => file.path)).toEqual(["one.txt", "two.txt"]);
    expect(first.truncated).toBe(true);
    expect(typeof first.next_cursor).toBe("string");
    await writeFile(join(root, "one.txt"), "changed\n", "utf8");
    const stale = await executeReadFileTool(call({
      workspace_root: root,
      requests: [{ path: "one.txt" }, { path: "two.txt" }],
      max_total_bytes: 5,
      cursor: first.next_cursor,
    })) as any;
    expect(stale.ok).toBe(false);
    expect(stale.error).toBe("cursor_stale");
  });

  test("keeps the requested line offset across aggregate and line continuations", async () => {
    await writeFile(join(root, "offset.txt"), "one\ntwo\nthree\n", "utf8");
    const first = await executeReadFileTool(call({ workspace_root: root, path: "offset.txt", start_line: 2, limit_lines: 1, max_total_bytes: 2 })) as any;
    expect(first.content).toBe("tw");
    expect(first.start_line).toBe(2);
    expect(first.end_line).toBe(2);
    const second = await executeReadFileTool(call({ workspace_root: root, path: "offset.txt", start_line: 2, limit_lines: 1, max_total_bytes: 2, cursor: first.next_cursor })) as any;
    expect(second.content).toBe("o");
    expect(second.start_line).toBe(2);
    const third = await executeReadFileTool(call({ workspace_root: root, path: "offset.txt", start_line: 2, limit_lines: 1, max_total_bytes: 2, cursor: second.next_cursor })) as any;
    expect(third.content).toBe("th");
    expect(third.start_line).toBe(3);
    expect(third.content).not.toBe("\n");
  });

  test("preserves UTF-8 boundaries while continuing from a non-first line", async () => {
    await writeFile(join(root, "unicode-lines.txt"), "첫째\n한🙂글\n끝\n", "utf8");
    const first = await executeReadFileTool(call({ workspace_root: root, path: "unicode-lines.txt", start_line: 2, limit_lines: 1, max_total_bytes: 4 })) as any;
    expect(first.ok).toBe(true);
    expect(first.content).toBe("한");
    expect(first.start_line).toBe(2);
    expect(first.content.includes("�")).toBe(false);
    const second = await executeReadFileTool(call({ workspace_root: root, path: "unicode-lines.txt", start_line: 2, limit_lines: 1, max_total_bytes: 4, cursor: first.next_cursor })) as any;
    expect(second.ok).toBe(true);
    expect(second.content).toBe("🙂");
    expect(second.start_line).toBe(2);
    expect(second.content.includes("�")).toBe(false);
  });

  test("rejects forged read cursor offsets at UTF-8 boundaries and EOF", async () => {
    await writeFile(join(root, "cursor-unicode.txt"), "🙂x", "utf8");
    const first = await executeReadFileTool(call({ workspace_root: root, path: "cursor-unicode.txt", max_bytes: 4 })) as any;
    const decoded = decodeFileToolCursor(first.next_cursor) as any;
    expect(decoded).not.toBeNull();
    const forge = (offset_bytes: number) => encodeFileToolCursor({
      tool: "read_file",
      query: decoded.query,
      request_index: decoded.request_index,
      offset_bytes,
      file_sha256: decoded.file_sha256,
    });
    const midCharacter = await executeReadFileTool(call({ workspace_root: root, path: "cursor-unicode.txt", max_bytes: 4, cursor: forge(1) })) as any;
    expect(midCharacter.error).toBe("invalid_cursor");
    const beyondEof = await executeReadFileTool(call({ workspace_root: root, path: "cursor-unicode.txt", max_bytes: 4, cursor: forge(100) })) as any;
    expect(beyondEof.error).toBe("invalid_cursor");
  });
});

describe("list_files", () => {
  test("is a real registered structural discovery path with bounded continuation", async () => {
    await mkdir(join(root, "src", "generated"), { recursive: true });
    await writeFile(join(root, "src", "a.ts"), "a", "utf8");
    await writeFile(join(root, "src", "generated", "ignored.ts"), "ignored", "utf8");
    const definition = listFilesToolDefinition.parameters as any;
    expect(definition.properties).toHaveProperty("root");
    expect(definition.properties).toHaveProperty("include_globs");
    expect(definition.properties).toHaveProperty("exclude_globs");
    expect(definition.properties).not.toHaveProperty("include");
    const handlers = createFileToolHandlers({ workspacePath: root });
    const result = await handlers.list_files!({
      name: "list_files",
      args: { root: "src", exclude_globs: ["generated/**"], max_results: 1 },
      rawArguments: "{}",
    } as any) as any;
    expect(result.ok).toBe(true);
    expect(result.files).toEqual([{ path: "src/a.ts", bytes: 1 }]);
    expect(result.evidence_receipts[0].covers).toContain("workspace_file_list");
    expect(result.evidence_receipts[0].satisfies).not.toContain("source_verified");
    expect(result.evidence_capability_receipts[0].verified).toBe(false);
  });

  test("continues deterministic discovery pages, prunes globs, and skips symlinks", async () => {
    await mkdir(join(root, "nested"), { recursive: true });
    await writeFile(join(root, "a.txt"), "a", "utf8");
    await writeFile(join(root, "nested", "b.txt"), "bb", "utf8");
    await writeFile(join(root, "nested", "ignored.md"), "ignored", "utf8");
    await symlink("a.txt", join(root, "alias.txt"));
    await symlink("nested", join(root, "alias-dir"));
    const first = await executeListFilesTool(call({ workspace_root: root, include_globs: ["**/*.txt"], exclude_globs: ["nested/**"], max_results: 1 })) as any;
    expect(first.ok).toBe(true);
    expect(first.files).toEqual([{ path: "a.txt", bytes: 1 }]);
    expect(first.truncated).toBe(true);
    const second = await executeListFilesTool(call({ workspace_root: root, include_globs: ["**/*.txt"], exclude_globs: ["nested/**"], max_results: 1, cursor: first.next_cursor })) as any;
    expect(second.ok).toBe(true);
    expect(second.files).toEqual([]);
    expect(second.next_cursor).toBeUndefined();
    expect(second.files.some((file: any) => file.path === "alias.txt")).toBe(false);
    expect(second.files.some((file: any) => file.path.startsWith("alias-dir/"))).toBe(false);
  });

  test("rejects disagreement between canonical and replay glob aliases", async () => {
    const list = await executeListFilesTool(call({ workspace_root: root, include_globs: ["src/**"], include: ["tests/**"] })) as any;
    expect(list.ok).toBe(false);
    expect(list.error).toBe("invalid_arguments");
    const grep = await executeGrepFilesTool(call({ workspace_root: root, pattern: "needle", exclude_globs: ["src/**"], exclude: ["tests/**"] })) as any;
    expect(grep.ok).toBe(false);
    expect(grep.error).toBe("invalid_arguments");
  });

  test("rejects malformed canonical and replay glob values before broad traversal", async () => {
    const list = await executeListFilesTool(call({ workspace_root: root, include_globs: [123] })) as any;
    expect(list.ok).toBe(false);
    expect(list.error).toBe("invalid_arguments");
    const grep = await executeGrepFilesTool(call({ workspace_root: root, pattern: "needle", exclude: "not-an-array" })) as any;
    expect(grep.ok).toBe(false);
    expect(grep.error).toBe("invalid_arguments");
  });

  test("prunes runtime protected Project Ledger roots from structural discovery", async () => {
    const protectedRoot = join(root, "custom-ledger");
    await mkdir(join(protectedRoot, "specs"), { recursive: true });
    await writeFile(join(protectedRoot, "secret.txt"), "needle", "utf8");
    await writeFile(join(root, "visible.txt"), "visible", "utf8");
    const context = { protectedProjectLedgerRoots: [protectedRoot] };
    const list = await executeListFilesTool(call({ workspace_root: root }), context) as any;
    expect(list.files.map((file: any) => file.path)).toEqual(["visible.txt"]);
    const grep = await executeGrepFilesTool(call({ workspace_root: root, pattern: "needle" }), context) as any;
    expect(grep.matches).toEqual([]);
    expect(grep.metrics.candidate_reads).toBe(1);
    expect(JSON.stringify(grep)).not.toContain("custom-ledger");
  });

  test("requires list and grep roots to be directories", async () => {
    await writeFile(join(root, "one.txt"), "needle", "utf8");
    const list = await executeListFilesTool(call({ workspace_root: root, root: "one.txt" })) as any;
    expect(list.ok).toBe(false);
    expect(list.error).toBe("not_a_directory");
    const grep = await executeGrepFilesTool(call({ workspace_root: root, root: "one.txt", pattern: "needle" })) as any;
    expect(grep.ok).toBe(false);
    expect(grep.error).toBe("not_a_directory");
  });

  test("does not emit a repeating cursor when a directory cap stops before a file boundary", async () => {
    await mkdir(join(root, "a"), { recursive: true });
    await writeFile(join(root, "a", "file.txt"), "x", "utf8");
    const result = await executeListFilesTool(call({ workspace_root: root, max_dirs: 1 })) as any;
    expect(result.files).toEqual([]);
    expect(result.stopped_by).toBe("max_dirs");
    expect(result.next_cursor).toBeUndefined();
    expect(result.evidence_receipts[0].summary).toContain("bounded partial result");
    expect(result.evidence_receipts[0].summary).not.toContain("continuation");
    expect(result.recovery_hint).toContain("safe file boundary");
  });
});

describe("write_file", () => {
  test("creates, overwrites with expected_sha256, rejects stale guard", async () => {
    const created = await executeWriteFileTool(call({ workspace_root: root, path: "dir/a.txt", content: "one", create_parents: true })) as any;
    expect(created.ok).toBe(true); expect(created.created).toBe(true); expect(await readFile(join(root, "dir/a.txt"), "utf8")).toBe("one");
    const stale = await executeWriteFileTool(call({ workspace_root: root, path: "dir/a.txt", content: "two", overwrite: true, expected_sha256: "bad" })) as any;
    expect(stale.error).toBe("expected_sha256_mismatch");
    const good = await executeWriteFileTool(call({ workspace_root: root, path: "dir/a.txt", content: "two", overwrite: true, expected_sha256: sha256Hex("one") })) as any;
    expect(good.ok).toBe(true); expect(good.atomic_write).toBe(true); expect(good.after_sha256).toBe(sha256Hex("two"));
  });

  test("rejects workspace Project Ledger source and generated-view writes even with matching expected_sha256", async () => {
    await mkdir(join(root, ".project-ledger", "specs"), { recursive: true });
    await mkdir(join(root, ".project-ledger", "views"), { recursive: true });
    await writeFile(join(root, ".project-ledger", "specs", "feature.md"), "old", "utf8");
    await writeFile(join(root, ".project-ledger", "views", "dashboard.md"), "old-view", "utf8");

    const source = await executeWriteFileTool(call({
      workspace_root: root,
      path: ".project-ledger/specs/feature.md",
      content: "new",
      overwrite: true,
      expected_sha256: sha256Hex("old"),
    })) as any;
    expect(source.ok).toBe(false);
    expect(source.error).toBe("protected_path");
    expect(source.guard.next[0].command).toContain("project-ledger");
    expect(await readFile(join(root, ".project-ledger", "specs", "feature.md"), "utf8")).toBe("old");

    const generated = await executeWriteFileTool(call({
      workspace_root: root,
      path: ".project-ledger/views/dashboard.md",
      content: "new-view",
      overwrite: true,
      expected_sha256: sha256Hex("old-view"),
    })) as any;
    expect(generated.ok).toBe(false);
    expect(generated.error).toBe("protected_path");
    expect(await readFile(join(root, ".project-ledger", "views", "dashboard.md"), "utf8")).toBe("old-view");
  });

  test("rejects Project Ledger writes through in-workspace symlink aliases", async () => {
    await mkdir(join(root, ".project-ledger", "specs"), { recursive: true });
    await mkdir(join(root, ".project-ledger", "index"), { recursive: true });
    await writeFile(join(root, ".project-ledger", "specs", "feature.md"), "old", "utf8");
    await symlink(".project-ledger", join(root, "ledger-link"));

    const existingLeaf = await executeWriteFileTool(call({
      workspace_root: root,
      path: "ledger-link/specs/feature.md",
      content: "new",
      overwrite: true,
      expected_sha256: sha256Hex("old"),
    })) as any;
    expect(existingLeaf.ok).toBe(false);
    expect(existingLeaf.error).toBe("protected_path");
    expect(await readFile(join(root, ".project-ledger", "specs", "feature.md"), "utf8")).toBe("old");

    const missingLeaf = await executeWriteFileTool(call({
      workspace_root: root,
      path: "ledger-link/index/generated.json",
      content: "{}",
    })) as any;
    expect(missingLeaf.ok).toBe(false);
    expect(missingLeaf.error).toBe("protected_path");
  });

  test("rejects BUTLER_DATA Project Ledger writes and allows ordinary writes", async () => {
    const originalButlerData = process.env.BUTLER_DATA;
    const butlerData = join(root, "butler-data");
    const ledgerRoot = join(butlerData, "project-ledger", "projects", "demo");
    await mkdir(join(ledgerRoot, "work"), { recursive: true });
    await writeFile(join(ledgerRoot, "work", "w.md"), "old", "utf8");
    process.env.BUTLER_DATA = butlerData;
    try {
      const protectedWrite = await executeWriteFileTool(call({
        workspace_root: ledgerRoot,
        path: "work/w.md",
        content: "new",
        overwrite: true,
        expected_sha256: sha256Hex("old"),
      })) as any;
      expect(protectedWrite.ok).toBe(false);
      expect(protectedWrite.error).toBe("protected_path");
      expect(await readFile(join(ledgerRoot, "work", "w.md"), "utf8")).toBe("old");
    } finally {
      if (originalButlerData === undefined) delete process.env.BUTLER_DATA;
      else process.env.BUTLER_DATA = originalButlerData;
    }

    const ordinary = await executeWriteFileTool(call({ workspace_root: root, path: "notes/out.md", content: "ok", create_parents: true })) as any;
    expect(ordinary.ok).toBe(true);
    expect(await readFile(join(root, "notes", "out.md"), "utf8")).toBe("ok");
  });

  test("rejects explicit Project Ledger roots supplied by runtime policy", async () => {
    const selectedRoot = join(root, "selected-ledger");
    await mkdir(join(selectedRoot, "plans"), { recursive: true });
    const result = await executeWriteFileTool(
      call({ workspace_root: root, path: "selected-ledger/plans/plan.md", content: "new", create_parents: true }),
      { protectedProjectLedgerRoots: [selectedRoot] },
    ) as any;
    expect(result.ok).toBe(false);
    expect(result.error).toBe("protected_path");
  });

  test("rejects explicit Project Ledger roots through symlink aliases", async () => {
    const selectedRoot = join(root, "selected-ledger");
    await mkdir(join(selectedRoot, "views"), { recursive: true });
    await writeFile(join(selectedRoot, "views", "dashboard.md"), "old", "utf8");
    await symlink("selected-ledger", join(root, "selected-link"));

    const result = await executeWriteFileTool(
      call({
        workspace_root: root,
        path: "selected-link/views/dashboard.md",
        content: "new",
        overwrite: true,
        expected_sha256: sha256Hex("old"),
      }),
      { protectedProjectLedgerRoots: [selectedRoot] },
    ) as any;
    expect(result.ok).toBe(false);
    expect(result.error).toBe("protected_path");
    expect(await readFile(join(selectedRoot, "views", "dashboard.md"), "utf8")).toBe("old");
  });
});

describe("Project Ledger protected path roots", () => {
  test("detects operator fallback home Project Ledger projects root", async () => {
    const fakeHome = join(root, "home");
    const fallbackRoot = join(fakeHome, ".butler", "project-ledger", "projects", "demo");
    await mkdir(join(fallbackRoot, "specs"), { recursive: true });

    const result = projectLedgerProtectedPath({
      workspaceRoot: root,
      absolutePath: join(fallbackRoot, "specs", "feature.md"),
      env: {},
      homeDir: fakeHome,
    });

    expect(result.protected).toBe(true);
    expect(result.code).toBe("protected_path");
  });
});

describe("grep_files", () => {
  test("exposes pattern as the only required search text field", () => {
    const parameters = grepFilesToolDefinition.parameters as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(parameters.required).toEqual(["pattern"]);
    expect(parameters.properties).toHaveProperty("pattern");
    expect(parameters.properties).not.toHaveProperty("query");
    expect(parameters.properties).toHaveProperty("include_globs");
    expect(parameters.properties).toHaveProperty("exclude_globs");
    expect(parameters.properties).toHaveProperty("max_output_bytes");
    expect(parameters.properties).not.toHaveProperty("mode");
    expect(parameters.properties).not.toHaveProperty("include");
    expect(parameters.properties).not.toHaveProperty("exclude");
  });

  test("rejects query-only search arguments instead of repairing aliases", async () => {
    const res = await executeGrepFilesTool(call({ workspace_root: root, query: "needle" })) as any;
    expect(res.ok).toBe(false);
    expect(res.error).toBe("missing_pattern");
  });

  test("supports include, exclude, context, truncation, and receipts", async () => {
    await mkdir(join(root, "src")); await writeFile(join(root, "src/a.ts"), "before\nneedle\nafter\n"); await writeFile(join(root, "src/a.md"), "needle\n");
    const res = await executeGrepFilesTool(call({ workspace_root: root, pattern: "NEEDLE", case_sensitive: false, include_globs:["src/*.ts"], exclude_globs:["**/*.md"], context_lines:1, max_matches:1 })) as any;
    expect(res.ok).toBe(true); expect(res.matches).toHaveLength(1); expect(res.matches[0].context).toHaveLength(3); expect(res.truncated).toBe(true); expect(res.evidence_receipts[0].producer.name).toBe("grep_files");
    expect(res.evidence_receipts[0].satisfies).toEqual([]);
    expect(res.evidence_capability_receipts[0]).toMatchObject({
      capability: "source_candidate",
      verified: false,
    });
    expect(res.evidence_capability_receipts[0].satisfies).toBeUndefined();
  });

  test("supports recursive slash-free globs and standard brace expansion", async () => {
    await mkdir(join(root, "src", "nested"), { recursive: true });
    await writeFile(join(root, "src", "a.ts"), "prompt_cache_key\n");
    await writeFile(join(root, "src", "nested", "b.js"), "prompt_cache_key\n");
    await writeFile(join(root, "src", "nested", "c.md"), "prompt_cache_key\n");

    const res = await executeGrepFilesTool(call({
      workspace_root: root,
      pattern: "prompt_cache_key",
      include_globs: ["*.{ts,js}"],
    })) as any;

    expect(res.matches.map((match: { path: string }) => match.path)).toEqual([
      "src/a.ts",
      "src/nested/b.js",
    ]);
  });

  test("continues grep after the last path/line without duplicating it", async () => {
    await writeFile(join(root, "a.txt"), "needle\nneedle\n", "utf8");
    await writeFile(join(root, "b.txt"), "needle\n", "utf8");
    const first = await executeGrepFilesTool(call({ workspace_root: root, pattern: "needle", max_matches: 1 })) as any;
    const second = await executeGrepFilesTool(call({ workspace_root: root, pattern: "needle", max_matches: 1, cursor: first.next_cursor })) as any;
    expect(first.matches.map((match: any) => `${match.path}:${match.line}`)).toEqual(["a.txt:1"]);
    expect(second.matches.map((match: any) => `${match.path}:${match.line}`)).toEqual(["a.txt:2"]);
    expect(second.matches).not.toContainEqual(first.matches[0]);
    const mismatch = await executeGrepFilesTool(call({ workspace_root: root, pattern: "other", max_matches: 1, cursor: first.next_cursor })) as any;
    expect(mismatch.ok).toBe(false);
    expect(mismatch.error).toBe("invalid_cursor");
  });

  test("keeps source-priority result ordering lossless across a root file before src", async () => {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "README.txt"), "needle\n", "utf8");
    await writeFile(join(root, "src", "a.txt"), "needle\n", "utf8");
    const first = await executeGrepFilesTool(call({ workspace_root: root, pattern: "needle", max_matches: 1 })) as any;
    const second = await executeGrepFilesTool(call({ workspace_root: root, pattern: "needle", max_matches: 1, cursor: first.next_cursor })) as any;
    expect(first.matches.map((match: any) => match.path)).toEqual(["src/a.txt"]);
    expect(second.matches.map((match: any) => match.path)).toEqual(["README.txt"]);
    expect(second.matches).not.toContainEqual(first.matches[0]);
    expect(second.next_cursor).toBeUndefined();
  });

  test("advances a no-match traversal cap to a later candidate and then terminates", async () => {
    await writeFile(join(root, "a.txt"), "no hit\n", "utf8");
    await writeFile(join(root, "b.txt"), "needle\n", "utf8");
    await writeFile(join(root, "c.txt"), "still no hit\n", "utf8");
    const first = await executeGrepFilesTool(call({ workspace_root: root, pattern: "needle", max_files: 1, max_matches: 1 })) as any;
    expect(first.matches).toEqual([]);
    expect(first.metrics.candidate_reads).toBe(1);
    const second = await executeGrepFilesTool(call({ workspace_root: root, pattern: "needle", max_files: 1, max_matches: 1, cursor: first.next_cursor })) as any;
    expect(second.matches.map((match: any) => `${match.path}:${match.line}`)).toEqual(["b.txt:1"]);
    expect(typeof second.next_cursor).toBe("string");
    const third = await executeGrepFilesTool(call({ workspace_root: root, pattern: "needle", max_files: 1, max_matches: 1, cursor: second.next_cursor })) as any;
    expect(third.matches).toEqual([]);
    expect(typeof third.next_cursor).toBe("string");
    const terminal = await executeGrepFilesTool(call({ workspace_root: root, pattern: "needle", max_files: 1, max_matches: 1, cursor: third.next_cursor })) as any;
    expect(terminal.matches).toEqual([]);
    expect(terminal.next_cursor).toBeUndefined();
  });

  test("does not issue a grep cursor for an unsafe directory traversal stop", async () => {
    await mkdir(join(root, "a", "b"), { recursive: true });
    await writeFile(join(root, "a", "b", "needle.txt"), "needle\n", "utf8");
    const result = await executeGrepFilesTool(call({ workspace_root: root, pattern: "needle", max_dirs: 1 })) as any;
    expect(result.truncated).toBe(true);
    expect(result.stopped_by).toBe("max_dirs");
    expect(result.next_cursor).toBeUndefined();
    expect(result.recovery_hint).toContain("safe file boundary");
  });

  test("stops candidate reads within one bounded batch after max_matches", async () => {
    for (let index = 0; index < 24; index += 1) await writeFile(join(root, `candidate-${String(index).padStart(2, "0")}.txt`), index === 0 ? "needle\n" : "no hit\n", "utf8");
    const result = await executeGrepFilesTool(call({ workspace_root: root, pattern: "needle", max_matches: 1 })) as any;
    expect(result.matches).toHaveLength(1);
    expect(result.metrics.candidate_reads).toBeLessThanOrEqual(4);
    expect(result.metrics.candidate_reads).toBeLessThan(result.files_considered);
  });

  test("bounds long match and context payloads with UTF-8-safe output truncation", async () => {
    await writeFile(join(root, "long.txt"), `${"before ".repeat(1000)}\n${"needle🙂".repeat(5000)}\n${"after ".repeat(1000)}\n`, "utf8");
    const result = await executeGrepFilesTool(call({ workspace_root: root, pattern: "needle", context_lines: 1, max_output_bytes: 512 })) as any;
    expect(result.ok).toBe(true);
    expect(result.output_truncated).toBe(true);
    expect(result.stopped_by).toBe("max_output_bytes");
    expect(result.output_bytes).toBeLessThanOrEqual(512);
    expect(result.matches[0].text.includes("�")).toBe(false);
    expect(result.matches[0].payload_truncated).toBe(true);
    expect(typeof result.next_cursor).toBe("string");
    const continuation = await executeGrepFilesTool(call({ workspace_root: root, pattern: "needle", context_lines: 1, max_output_bytes: 512, cursor: result.next_cursor })) as any;
    expect(continuation.matches).toEqual([]);
    expect(continuation.next_cursor).toBeUndefined();
  });

  test("counts and skips binary and strict invalid UTF-8 candidates", async () => {
    await writeFile(join(root, "binary.dat"), Buffer.from([0, 1, 2, 3]));
    await writeFile(join(root, "invalid.dat"), Buffer.from([0xc3, 0x28]));
    const result = await executeGrepFilesTool(call({ workspace_root: root, pattern: "needle" })) as any;
    expect(result.binary_files).toBe(1);
    expect(result.invalid_utf8_files).toBe(1);
    expect(result.files_skipped).toBeGreaterThanOrEqual(2);
  });

  test("reports oversized candidates as partial rather than exhaustive", async () => {
    await writeFile(join(root, "large.txt"), "needle-but-too-large", "utf8");
    const result = await executeGrepFilesTool(call({ workspace_root: root, pattern: "needle", max_bytes_per_file: 2 })) as any;
    expect(result.ok).toBe(true);
    expect(result.matches).toEqual([]);
    expect(result.truncated).toBe(true);
    expect(result.partial_reasons).toContain("max_bytes_per_file");
    expect(result.recovery_hint).toContain("max_bytes_per_file");
    expect(result.next_cursor).toBeUndefined();
    expect(result.evidence_receipts[0].summary).toContain("bounded partial result");
    expect(result.evidence_receipts[0].summary).not.toContain("continuation");
  });

  test("keeps admitted matches pageable when one candidate is oversized", async () => {
    await writeFile(join(root, "a-large.txt"), "needle-too-large", "utf8");
    await writeFile(join(root, "b-small.txt"), "needle\n", "utf8");
    await writeFile(join(root, "c-small.txt"), "needle\n", "utf8");
    const first = await executeGrepFilesTool(call({ workspace_root: root, pattern: "needle", max_bytes_per_file: 8, max_matches: 1 })) as any;
    expect(first.partial).toBe(true);
    expect(first.matches.map((match: any) => match.path)).toEqual(["b-small.txt"]);
    expect(typeof first.next_cursor).toBe("string");
    const second = await executeGrepFilesTool(call({ workspace_root: root, pattern: "needle", max_bytes_per_file: 8, max_matches: 1, cursor: first.next_cursor })) as any;
    expect(second.matches.map((match: any) => match.path)).toEqual(["c-small.txt"]);
  });

  test("rechecks the current candidate size immediately before read", async () => {
    const path = join(root, "grown.txt");
    await writeFile(path, "0123456789", "utf8");
    const result = await readCandidate({ path: "grown.txt", absolutePath: path, bytes: 1 }, "needle", "", 0, 2, 10, 1024);
    expect(result.reason).toBe("max_bytes_per_file");
    expect(result.attemptedRead).toBe(false);
  });

  test("validates replay aliases and cursor parent markers without rejecting harmless dots", async () => {
    await writeFile(join(root, "version..txt"), "needle\n", "utf8");
    const disagreement = await executeGrepFilesTool(call({ workspace_root: root, pattern: "needle", regex: true, mode: "literal" })) as any;
    expect(disagreement.ok).toBe(false);
    expect(disagreement.error).toBe("invalid_arguments");
    const query = "a".repeat(64);
    const harmless = encodeFileToolCursor({ tool: "grep_files", query, marker: "version..txt", line: 1, scan_path: "version..txt", scan_inclusive: true, window_start_path: "version..txt", window_end_path: "version..txt" });
    expect(decodeFileToolCursor(harmless)).not.toBeNull();
    const parent = encodeFileToolCursor({ tool: "grep_files", query, marker: "dir/../file.txt", line: 1 });
    expect(decodeFileToolCursor(parent)).toBeNull();
    for (const marker of ["C:/workspace/file.txt", "\\\\server\\share\\file.txt", "~/workspace/file.txt"]) {
      expect(decodeFileToolCursor(encodeFileToolCursor({ tool: "grep_files", query, marker, line: 1 }))).toBeNull();
    }
    expect(decodeFileToolCursor(encodeFileToolCursor({ tool: "grep_files", query, marker: "version..txt" }))).toBeNull();
    expect(decodeFileToolCursor(encodeFileToolCursor({ tool: "list_files", query, marker: "a.txt", scan_path: "a.txt", scan_inclusive: false }))).toBeNull();
    expect(decodeFileToolCursor(encodeFileToolCursor({ tool: "read_file", query, request_index: 0, offset_bytes: 0, file_sha256: query, marker: "a.txt" }))).toBeNull();
  });

  test("rejects query-matching cursors with the wrong per-tool shape", async () => {
    await writeFile(join(root, "a.txt"), "needle\n", "utf8");
    await writeFile(join(root, "b.txt"), "needle\n", "utf8");
    const grepFirst = await executeGrepFilesTool(call({ workspace_root: root, pattern: "needle", max_matches: 1 })) as any;
    const grepCursor = decodeFileToolCursor(grepFirst.next_cursor) as any;
    const malformedGrep = encodeFileToolCursor({ tool: "grep_files", query: grepCursor.query, marker: grepCursor.marker });
    const grepResult = await executeGrepFilesTool(call({ workspace_root: root, pattern: "needle", max_matches: 1, cursor: malformedGrep })) as any;
    expect(grepResult.error).toBe("invalid_cursor");

    const listFirst = await executeListFilesTool(call({ workspace_root: root, max_results: 1 })) as any;
    const listCursor = decodeFileToolCursor(listFirst.next_cursor) as any;
    const malformedList = encodeFileToolCursor({ tool: "list_files", query: listCursor.query, marker: listCursor.marker, scan_path: listCursor.marker, scan_inclusive: false });
    const listResult = await executeListFilesTool(call({ workspace_root: root, max_results: 1, cursor: malformedList })) as any;
    expect(listResult.error).toBe("invalid_cursor");
  });

  test("batch read evidence names only successful admitted workspace-relative files", async () => {
    await writeFile(join(root, "first.txt"), "one", "utf8");
    await writeFile(join(root, "second.txt"), "two", "utf8");
    const success = await executeReadFileTool(call({ workspace_root: root, requests: [{ path: "first.txt" }, { path: "second.txt" }] })) as any;
    const successCapability = success.evidence_capability_receipts[0];
    expect(successCapability.capability).toBe("source_verified");
    expect(successCapability.references.map((reference: any) => reference.path)).toEqual(["first.txt", "second.txt"]);
    expect(JSON.stringify(successCapability)).not.toContain(root);

    const page1 = await executeReadFileTool(call({ workspace_root: root, requests: [{ path: "first.txt" }, { path: "second.txt" }], max_total_bytes: 4 })) as any;
    expect(typeof page1.next_cursor).toBe("string");
    const page2 = await executeReadFileTool(call({ workspace_root: root, requests: [{ path: "first.txt" }, { path: "second.txt" }], max_total_bytes: 4, cursor: page1.next_cursor })) as any;
    expect(page2.evidence_capability_receipts[0].references.map((reference: any) => reference.path)).toEqual(["second.txt"]);

    await writeFile(join(root, "emoji.txt"), "🙂", "utf8");
    const noCursorPartial = await executeReadFileTool(call({ workspace_root: root, requests: [{ path: "emoji.txt" }], max_total_bytes: 1 })) as any;
    expect(noCursorPartial.next_cursor).toBeUndefined();
    expect(noCursorPartial.evidence_receipts[0].summary).toContain("bounded partial result");
    expect(noCursorPartial.evidence_receipts[0].summary).not.toContain("continuation");

    await writeFile(join(root, "bad.bin"), Buffer.from([0, 1, 2]));
    const failed = await executeReadFileTool(call({ workspace_root: root, requests: [{ path: "missing.txt" }, { path: "bad.bin" }] })) as any;
    expect(failed.evidence_capability_receipts[0].capability).toBe("limitation_recorded");
    expect(failed.evidence_receipts[0].satisfies).not.toContain("source_verified");
    expect(JSON.stringify(failed.evidence_capability_receipts)).not.toContain(root);
  });
});
