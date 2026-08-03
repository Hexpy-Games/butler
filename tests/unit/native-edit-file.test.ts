import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  editFileToolDefinition,
  executeEditFileTool,
  locateExactText,
} from "../../packages/butler-agent/src/agent/tools/file-tools/edit_file/index.ts";
import { sha256Hex } from
  "../../packages/butler-agent/src/agent/tools/file-tools/shared/evidence.ts";
import { withButlerFileMutationLock } from
  "../../packages/butler-agent/src/agent/tools/file-tools/shared/workspace-file-mutation-lock.ts";
import {
  executeWriteFileTool,
  writeFileToolDefinition,
} from
  "../../packages/butler-agent/src/agent/tools/file-tools/write_file/index.ts";

let workspace = "";
let outside = "";

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "butler-edit-file-workspace-"));
  outside = await mkdtemp(join(tmpdir(), "butler-edit-file-outside-"));
});

afterEach(async () => {
  await Promise.all([
    rm(workspace, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true }),
  ]);
});

function call(args: Record<string, unknown>) {
  return { arguments: args };
}

describe("edit_file definition", () => {
  test("separates exact edits from complete-file writes", () => {
    const parameters = editFileToolDefinition.parameters as {
      properties: Record<string, { minLength?: number }>;
      required: string[];
    };
    expect(parameters.required).toEqual([
      "path",
      "old_text",
      "new_text",
    ]);
    expect(parameters.properties.start_line).toMatchObject({
      type: "integer",
      minimum: 1,
    });
    expect(parameters.properties.old_text.minLength).toBe(1);
    expect(parameters.properties.new_text.minLength).toBeUndefined();
    expect(parameters.properties).toHaveProperty("expected_sha256");
    expect(editFileToolDefinition.description).toContain("small, exact change");
    expect(editFileToolDefinition.description).toContain("location hint");
    expect(writeFileToolDefinition.description).toContain("complete desired content");
    expect(writeFileToolDefinition.description).toContain("use edit_file");
  });
});

describe("edit_file execution", () => {
  test("locates large repeated text with bounded occurrence state", () => {
    const text = "needle\n".repeat(100_000);
    expect(locateExactText({ text, oldText: "needle" })).toEqual({
      ok: false,
      error: "old_text_ambiguous",
      occurrenceCount: 2,
    });
    expect(locateExactText({ text, oldText: "needle", startLine: 50_000 }))
      .toEqual({ ok: true, value: { offset: (50_000 - 1) * 7, startLine: 50_000 } });
  });

  test("replaces one exact multiline range at start_line atomically", async () => {
    const path = join(workspace, "src.ts");
    const before = "const a = 1;\nfunction value() {\n  return a;\n}\nconst a = 2;\n";
    const after = "const a = 1;\nfunction value() {\n  return a + 1;\n}\nconst a = 2;\n";
    await writeFile(path, before, "utf8");

    const result = await executeEditFileTool(call({
      path: "src.ts",
      start_line: 2,
      old_text: "function value() {\n  return a;\n}",
      new_text: "function value() {\n  return a + 1;\n}",
      expected_sha256: sha256Hex(before),
    }), { workspacePath: workspace }) as any;

    expect(result).toMatchObject({
      ok: true,
      path: "src.ts",
      start_line: 2,
      replacements: 1,
      before_sha256: sha256Hex(before),
      after_sha256: sha256Hex(after),
      atomic_write: true,
    });
    expect(await readFile(path, "utf8")).toBe(after);
    expect(result.evidence_receipts[0].producer.name).toBe("edit_file");
    expect(result.evidence_receipts[0].covers).toContain(
      "workspace_file_written",
    );
    expect(result.evidence_capability_receipts[0]).toMatchObject({
      producer: { kind: "tool", name: "edit_file" },
      capability: "workspace_mutated",
      verified: true,
      scope: { operation: "edited" },
    });
  });

  test("allows an empty replacement and preserves the existing file mode", async () => {
    const path = join(workspace, "notes.txt");
    await writeFile(path, "keep\nremove me\nafter\n", { mode: 0o640 });
    const beforeMode = (await lstat(path)).mode & 0o777;

    const result = await executeEditFileTool(call({
      path: "notes.txt",
      start_line: 2,
      old_text: "remove me\n",
      new_text: "",
    }), { workspacePath: workspace }) as any;

    expect(result.ok).toBe(true);
    expect(await readFile(path, "utf8")).toBe("keep\nafter\n");
    expect((await lstat(path)).mode & 0o777).toBe(beforeMode);
  });

  test("serializes Butler write_file and edit_file stale-write checks", async () => {
    await mkdir(join(workspace, "real"));
    await symlink("real", join(workspace, "alias"));
    const path = join(workspace, "real", "shared.txt");
    const before = "value\n";
    await writeFile(path, before, "utf8");

    let releaseHolder = () => {};
    let markEntered = () => {};
    const held = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const holder = withButlerFileMutationLock(async () => {
      markEntered();
      await held;
    });
    await entered;

    let editSettled = false;
    let writeSettled = false;
    const edit = executeEditFileTool(call({
      path: "real/shared.txt",
      start_line: 1,
      old_text: "value",
      new_text: "edited",
      expected_sha256: sha256Hex(before),
    }), { workspacePath: workspace }).then((result) => {
      editSettled = true;
      return result as any;
    });
    const write = executeWriteFileTool(call({
      path: "alias/shared.txt",
      content: "written\n",
      overwrite: true,
      expected_sha256: sha256Hex(before),
    }), { workspacePath: workspace }).then((result) => {
      writeSettled = true;
      return result as any;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(editSettled).toBe(false);
    expect(writeSettled).toBe(false);
    releaseHolder();
    await holder;

    const results = await Promise.all([edit, write]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) =>
      result.error === "expected_sha256_mismatch",
    )).toHaveLength(1);
    expect(["edited\n", "written\n"]).toContain(
      await readFile(path, "utf8"),
    );
  });

  test("serializes the same file admitted through nested workspaces", async () => {
    const nestedWorkspace = join(workspace, "nested");
    await mkdir(nestedWorkspace);
    const path = join(nestedWorkspace, "shared.txt");
    const before = "value\n";
    await writeFile(path, before, "utf8");

    let releaseHolder = () => {};
    let markEntered = () => {};
    const held = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const holder = withButlerFileMutationLock(async () => {
      markEntered();
      await held;
    });
    await entered;

    let parentSettled = false;
    let nestedSettled = false;
    const fromParent = executeEditFileTool(call({
      path: "nested/shared.txt",
      start_line: 1,
      old_text: "value",
      new_text: "edited",
      expected_sha256: sha256Hex(before),
    }), { workspacePath: workspace }).then((result) => {
      parentSettled = true;
      return result;
    });
    const fromNested = executeWriteFileTool(call({
      path: "shared.txt",
      content: "written\n",
      overwrite: true,
      expected_sha256: sha256Hex(before),
    }), { workspacePath: nestedWorkspace }).then((result) => {
      nestedSettled = true;
      return result;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(parentSettled).toBe(false);
    expect(nestedSettled).toBe(false);
    releaseHolder();
    await holder;
    const results = await Promise.all([fromParent, fromNested]) as any[];
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) =>
      result.error === "expected_sha256_mismatch",
    )).toHaveLength(1);
  });

  test("serializes new-file names that may alias on the host filesystem", async () => {
    await writeFile(join(workspace, "case-probe.txt"), "probe", "utf8");
    const caseInsensitive = await realpath(
      join(workspace, "CASE-PROBE.TXT"),
    ).then(() => true, () => false);

    let releaseHolder = () => {};
    let markEntered = () => {};
    const held = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const holder = withButlerFileMutationLock(async () => {
      markEntered();
      await held;
    });
    await entered;

    let upperSettled = false;
    let lowerSettled = false;
    const upper = executeWriteFileTool(call({
      path: "CaseMissing.txt",
      content: "upper\n",
      overwrite: false,
    }), { workspacePath: workspace }).then((result) => {
      upperSettled = true;
      return result as any;
    });
    const lower = executeWriteFileTool(call({
      path: "casemissing.txt",
      content: "lower\n",
      overwrite: false,
    }), { workspacePath: workspace }).then((result) => {
      lowerSettled = true;
      return result as any;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(upperSettled).toBe(false);
    expect(lowerSettled).toBe(false);
    releaseHolder();
    await holder;

    const results = await Promise.all([upper, lower]);
    const successes = results.filter((result) => result.ok);
    expect(successes).toHaveLength(caseInsensitive ? 1 : 2);
    if (caseInsensitive) {
      expect(results.filter((result) => result.error === "file_exists"))
        .toHaveLength(1);
    }
  });

  test("rejects stale hashes and missing exact text while recovering from stale hints", async () => {
    const path = join(workspace, "stable.txt");
    const before = "alpha\nbeta\ngamma\n";
    await writeFile(path, before, "utf8");

    const stale = await executeEditFileTool(call({
      path: "stable.txt",
      start_line: 2,
      old_text: "beta",
      new_text: "changed",
      expected_sha256: "stale",
    }), { workspacePath: workspace }) as any;
    expect(stale.error).toBe("expected_sha256_mismatch");

    const wrongLine = await executeEditFileTool(call({
      path: "stable.txt",
      start_line: 1,
      old_text: "beta",
      new_text: "changed",
    }), { workspacePath: workspace }) as any;
    expect(wrongLine).toMatchObject({
      ok: true,
      start_line: 2,
    });
    expect(await readFile(path, "utf8")).toBe("alpha\nchanged\ngamma\n");

    await writeFile(path, before, "utf8");
    const noHint = await executeEditFileTool(call({
      path: "stable.txt",
      old_text: "beta",
      new_text: "changed",
    }), { workspacePath: workspace }) as any;
    expect(noHint).toMatchObject({
      ok: true,
      start_line: 2,
    });

    await writeFile(path, before, "utf8");
    const outOfRange = await executeEditFileTool(call({
      path: "stable.txt",
      start_line: 9,
      old_text: "delta",
      new_text: "changed",
    }), { workspacePath: workspace }) as any;
    expect(outOfRange.error).toBe("old_text_mismatch");
    expect(await readFile(path, "utf8")).toBe(before);
  });

  test("uses an exact hinted occurrence before rejecting duplicate text", async () => {
    const path = join(workspace, "duplicate.txt");
    const before = "alpha\nbeta\nbeta\ngamma\n";
    await writeFile(path, before, "utf8");

    const ambiguous = await executeEditFileTool(call({
      path: "duplicate.txt",
      start_line: 1,
      old_text: "beta",
      new_text: "changed",
    }), { workspacePath: workspace }) as any;
    expect(ambiguous.error).toBe("old_text_ambiguous");
    expect(await readFile(path, "utf8")).toBe(before);

    const hinted = await executeEditFileTool(call({
      path: "duplicate.txt",
      start_line: 2,
      old_text: "beta",
      new_text: "changed",
    }), { workspacePath: workspace }) as any;
    expect(hinted).toMatchObject({ ok: true, start_line: 2 });
    expect(await readFile(path, "utf8")).toBe("alpha\nchanged\nbeta\ngamma\n");
  });

  test("edits contained absolute paths but trusts the runtime workspace", async () => {
    const path = join(workspace, "owned.txt");
    await writeFile(path, "old\n", "utf8");

    const result = await executeEditFileTool(call({
      workspace_root: outside,
      path,
      start_line: 1,
      old_text: "old",
      new_text: "new",
    }), { workspacePath: workspace }) as any;

    expect(result.ok).toBe(true);
    expect(await readFile(path, "utf8")).toBe("new\n");
  });

  test("requires an existing regular UTF-8 file", async () => {
    await mkdir(join(workspace, "folder"));
    await writeFile(join(workspace, "binary.dat"), Buffer.from([1, 0, 2]));
    await writeFile(join(workspace, "invalid.txt"), Buffer.from([0xc3, 0x28]));
    await writeFile(join(workspace, "inside.txt"), "inside", "utf8");
    await symlink("inside.txt", join(workspace, "inside-link.txt"));

    const edit = (path: string) => executeEditFileTool(call({
      path,
      start_line: 1,
      old_text: "inside",
      new_text: "changed",
    }), { workspacePath: workspace }) as Promise<any>;

    expect((await edit("missing.txt")).error).toBe("not_found");
    expect((await edit("folder")).error).toBe("directory_not_allowed");
    expect((await edit("inside-link.txt")).error).toBe(
      "target_not_regular_file",
    );
    expect((await edit("binary.dat")).error).toBe(
      "binary_file_not_supported",
    );
    expect((await edit("invalid.txt")).error).toBe("invalid_utf8");
  });

  test("blocks traversal, sensitive paths, symlink escapes, and Project Ledger", async () => {
    await writeFile(join(outside, "outside.txt"), "outside", "utf8");
    await symlink(outside, join(workspace, "escape"));
    await writeFile(join(workspace, ".env.local"), "SECRET=value\n", "utf8");
    await mkdir(join(workspace, ".project-ledger", "specs"), {
      recursive: true,
    });
    await writeFile(
      join(workspace, ".project-ledger", "specs", "feature.md"),
      "old",
      "utf8",
    );

    const edit = (path: string) => executeEditFileTool(call({
      path,
      start_line: 1,
      old_text: "old",
      new_text: "new",
    }), { workspacePath: workspace }) as Promise<any>;

    expect((await edit("../outside.txt")).error).toBe(
      "parent_traversal_not_allowed",
    );
    expect((await edit(".env.local")).error).toBe("sensitive_path_blocked");
    expect((await edit("escape/outside.txt")).error).toBe("symlink_escape");
    const ledger = await edit(".project-ledger/specs/feature.md");
    expect(ledger.error).toBe("protected_path");
    expect(ledger.guard.next[0].command).toContain("project-ledger");
    expect(await readFile(
      join(workspace, ".project-ledger", "specs", "feature.md"),
      "utf8",
    )).toBe("old");
  });
});
