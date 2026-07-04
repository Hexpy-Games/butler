import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sha256Hex } from "../../packages/butler-agent/src/agent/tools/file-tools/shared/evidence.ts";
import { projectLedgerProtectedPath } from "../../packages/butler-agent/src/agent/tools/file-tools/shared/project-ledger-protection.ts";
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
    await writeFile(join(root, "bin.dat"), Buffer.from([1, 0, 2]));
    expect(((await executeReadFileTool(call({ workspace_root: root, path: "bin.dat" }))) as any).error).toBe("binary_file_not_supported");
  });

  test("rejects Project Ledger inspection through read_file", async () => {
    await mkdir(join(root, ".project-ledger", "specs"), { recursive: true });
    await writeFile(join(root, ".project-ledger", "specs", "feature.md"), "# Feature\n", "utf8");
    const res = await executeReadFileTool(call({ workspace_root: root, path: ".project-ledger/specs/feature.md" })) as any;
    expect(res.ok).toBe(false);
    expect(res.error).toBe("protected_path");
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
  test("supports include, exclude, context, truncation, and receipts", async () => {
    await mkdir(join(root, "src")); await writeFile(join(root, "src/a.ts"), "before\nneedle\nafter\n"); await writeFile(join(root, "src/a.md"), "needle\n");
    const res = await executeGrepFilesTool(call({ workspace_root: root, query: "NEEDLE", case_sensitive: false, include_globs:["src/*.ts"], exclude_globs:["**/*.md"], context_lines:1, max_matches:1 })) as any;
    expect(res.ok).toBe(true); expect(res.matches).toHaveLength(1); expect(res.matches[0].context).toHaveLength(3); expect(res.truncated).toBe(true); expect(res.evidence_receipts[0].producer.name).toBe("grep_files");
  });
});
