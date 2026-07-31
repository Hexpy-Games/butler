import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeGuidedReadOnlyCommand } from
  "../../packages/butler-agent/src/agent/composition/production-btcc/guided-read-only-command.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("R3 read-only command boundary", () => {
  test("observes the workspace through a no-write, no-network host boundary", async () => {
    const root = mkdtempSync(join(tmpdir(), "btcc-r3-command-"));
    roots.push(root);
    const result = await executeGuidedReadOnlyCommand({
      args: { command: "pwd", state_effect: "read_only" },
      butlerData: join(root, "data"),
      workspacePath: root,
      originalRequest: "show the current directory",
    });

    if (process.platform !== "darwin") {
      expect(result).toMatchObject({
        ok: false,
        error: { code: "command_observation_isolation_unavailable" },
      });
      return;
    }
    expect(result).toMatchObject({
      ok: true,
      exit_code: 0,
      sandbox: "read_only_no_network",
    });
    expect(String(result.stdout)).toContain(root);
  });

  test("does not trust a read_only label when the command attempts a write", async () => {
    const root = mkdtempSync(join(tmpdir(), "btcc-r3-command-write-"));
    roots.push(root);
    const target = join(root, "forbidden.txt");
    const result = await executeGuidedReadOnlyCommand({
      args: {
        command: "printf compromised > forbidden.txt",
        state_effect: "read_only",
      },
      butlerData: join(root, "data"),
      workspacePath: root,
      originalRequest: "inspect only",
    });

    expect(result.ok).toBe(false);
    expect(existsSync(target)).toBe(false);
  });

  test("rejects mutation declarations before launching a command", async () => {
    const root = mkdtempSync(join(tmpdir(), "btcc-r3-command-mutation-"));
    roots.push(root);
    const target = join(root, "forbidden.txt");
    const result = await executeGuidedReadOnlyCommand({
      args: {
        command: "printf compromised > forbidden.txt",
        state_effect: "mutation",
      },
      butlerData: join(root, "data"),
      workspacePath: root,
      originalRequest: "write a file",
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "command_mutation_requires_typed_effect" },
    });
    expect(existsSync(target)).toBe(false);
  });

  test("a Project Ledger CLI-shaped command cannot bypass the read-only host", async () => {
    const root = mkdtempSync(join(tmpdir(), "btcc-r3-command-ledger-"));
    roots.push(root);
    const bin = join(root, "packages", "project-ledger", "bin");
    const target = join(root, "trusted-bypass.txt");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "project-ledger.cjs"), [
      'require("node:fs").writeFileSync("trusted-bypass.txt", "bad");',
      'process.stdout.write("mutated");',
    ].join("\n"));
    const result = await executeGuidedReadOnlyCommand({
      args: {
        command: `${JSON.stringify(process.execPath)} packages/project-ledger/bin/project-ledger.cjs`,
        state_effect: "read_only",
      },
      butlerData: join(root, "data"),
      workspacePath: root,
      originalRequest: "inspect Project Ledger without changing it",
    });

    expect(result.ok).toBe(false);
    expect(existsSync(target)).toBe(false);
  });
});
