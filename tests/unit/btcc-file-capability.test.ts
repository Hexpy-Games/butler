import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeFileCapability } from "../../packages/butler-agent/src/agent/composition/production-btcc/capabilities/file-capabilities.ts";

test("BTCC grep_files applies explicit workspace glob filters", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "btcc-grep-"));
  try {
    await mkdir(join(workspace, "src"));
    await mkdir(join(workspace, "notes"));
    await writeFile(join(workspace, "src", "sample.ts"), "export const sample = true;\n");
    await writeFile(join(workspace, "notes", "sample.md"), "sample note\n");

    const typescript = await search(workspace, ["*.ts"]);
    expect(typescript.matches.map((match: { path: string }) => match.path)).toEqual([
      "src/sample.ts",
    ]);

    const sourceWithoutTypescript = await search(workspace, ["src/**"], ["**/*.ts"]);
    expect(sourceWithoutTypescript.matches).toEqual([]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("BTCC list_files discovers nested sources without searching file content", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "btcc-list-"));
  try {
    await mkdir(join(workspace, "src"));
    await mkdir(join(workspace, "tests"));
    await writeFile(join(workspace, "src", "sample.ts"), "");
    await writeFile(join(workspace, "tests", "sample.test.ts"), "");
    await writeFile(join(workspace, "README.md"), "");

    const result = await executeFileCapability("list_files", {
      include_globs: ["*.ts"],
      exclude_globs: ["tests/**"],
      max_files: 20,
    }, context(workspace)) as { files: string[]; truncated: boolean };

    expect(result).toEqual({ files: ["src/sample.ts"], truncated: false });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

async function search(workspace: string, includeGlobs: string[], excludeGlobs: string[] = []) {
  return await executeFileCapability("grep_files", {
    pattern: "sample",
    include_globs: includeGlobs,
    exclude_globs: excludeGlobs,
  }, context(workspace)) as { matches: Array<{ path: string }> };
}

function context(workspace: string) {
  return {
    butlerData: join(workspace, ".butler"),
    workspacePath: workspace,
    originalRequest: "inspect the sample module",
  };
}
