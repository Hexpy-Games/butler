import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeCommandCapability } from
  "../../packages/butler-agent/src/agent/composition/production-btcc/capabilities/command-capability.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

test("isolated commands cannot read or write the original project root", async () => {
  const root = mkdtempSync(join(tmpdir(), "btcc-command-sandbox-"));
  roots.push(root);
  const isolated = join(root, "isolated");
  const original = join(root, "original");
  mkdirSync(isolated);
  mkdirSync(original);
  writeFileSync(join(isolated, "target"), "reviewed bytes\n");
  writeFileSync(join(original, "source.ts"), "stale bytes\n");
  const command = [
    "cat target",
    `cat '${join(original, "source.ts")}'`,
    `printf compromised > '${join(original, "source.ts")}'`,
  ].join("; ");
  const run = executeCommandCapability({ command }, {
    butlerData: join(root, "data"),
    workspacePath: isolated,
    originalRequest: "review exact source",
    commandFilesystemBoundary: {
      kind: "isolated_workspace",
      deniedReadWriteRoots: [original],
    },
  });

  if (process.platform !== "darwin") {
    await expect(run).rejects.toMatchObject({ code: "command_filesystem_isolation_unavailable" });
    return;
  }
  const result = await run as { stdout: string; stderr: string };
  expect(result.stdout).toBe("reviewed bytes\n");
  expect(result.stderr).toContain("Operation not permitted");
  expect(readFileSync(join(original, "source.ts"), "utf8")).toBe("stale bytes\n");
});
