import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeGuidedReadOnlyCommand } from
  "../../packages/butler-agent/src/agent/composition/production-btcc/guided-read-only-command.ts";
import { executeGuidedCommandCall } from
  "../../packages/butler-agent/src/agent/composition/production-btcc/guided-command-execution.ts";

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

  test("accepts the displayed workspace root as cwd", async () => {
    const root = mkdtempSync(join(tmpdir(), "btcc-r3-command-root-cwd-"));
    roots.push(root);
    const result = await executeGuidedReadOnlyCommand({
      args: { command: "pwd", cwd: root, state_effect: "read_only" },
      butlerData: join(root, "data"),
      workspacePath: root,
      originalRequest: "show the current directory",
    });

    if (process.platform !== "darwin") return;
    expect(result).toMatchObject({ ok: true, cwd: root });
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

  test("defaults an omitted state effect to the read-only boundary", async () => {
    const root = mkdtempSync(join(tmpdir(), "btcc-r3-command-default-"));
    roots.push(root);
    const target = join(root, "forbidden.txt");
    const result = await executeGuidedReadOnlyCommand({
      args: { command: "printf compromised > forbidden.txt" },
      butlerData: join(root, "data"),
      workspacePath: root,
      originalRequest: "inspect only",
    });

    expect(result.ok).toBe(false);
    expect(existsSync(target)).toBe(false);
  });

  test("runs declared validation in a disposable workspace and preserves only declared artifacts", async () => {
    const root = mkdtempSync(join(tmpdir(), "btcc-r3-command-validation-"));
    roots.push(root);
    const data = join(root, "data");
    const workspace = join(root, "workspace");
    const artifactBase = join(data, "artifacts", "generated");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(artifactBase, { recursive: true });
    writeFileSync(join(workspace, "source.txt"), "original");
    writeFileSync(join(artifactBase, "result.txt"), "prior");
    const result = await executeGuidedCommandCall({
      call: {
        name: "run_command",
        rawArguments: "{}",
        args: {
          command: [
            "printf temporary > validation-only.txt",
            "mkdir -p \"$BUTLER_ARTIFACTS_DIR\"",
            "printf evidence > \"$BUTLER_ARTIFACTS_DIR/result.txt\"",
          ].join(" && "),
          state_effect: "validation",
          validation_suite: "unit-tests",
          output_paths: ["$BUTLER_ARTIFACTS_DIR/result.txt"],
        },
      },
      accessMode: "full_access",
      butlerData: data,
      workspacePath: workspace,
      originalRequest: "validate the project",
      signal: new AbortController().signal,
    });

    if (process.platform !== "darwin") {
      expect(result).toMatchObject({
        ok: false,
        error: { code: "command_validation_isolation_unavailable" },
      });
      return;
    }
    expect(result).toMatchObject({
      ok: true,
      exit_code: 0,
      sandbox: "isolated_validation_no_network",
    });
    const artifacts = (result as { artifacts?: Array<{ path: string }> }).artifacts ?? [];
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.path).toMatch(
      /^artifacts\/generated\/validation-[^/]+\/result\.txt$/,
    );
    expect(existsSync(join(workspace, "validation-only.txt"))).toBe(false);
    expect(readFileSync(join(artifactBase, "result.txt"), "utf8")).toBe("prior");
    expect(readFileSync(join(data, artifacts[0]!.path), "utf8")).toBe("evidence");
  });

  test("maps a displayed absolute workspace cwd into the disposable validation copy", async () => {
    const root = mkdtempSync(join(tmpdir(), "btcc-r3-command-validation-cwd-"));
    roots.push(root);
    const data = join(root, "data");
    const workspace = join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "package.json"), "{}\n");
    const result = await executeGuidedCommandCall({
      call: {
        name: "run_command",
        rawArguments: "{}",
        args: {
          command: "test -f package.json",
          cwd: workspace,
          state_effect: "validation",
          validation_suite: "absolute-workspace-cwd",
        },
      },
      accessMode: "full_access",
      butlerData: data,
      workspacePath: workspace,
      originalRequest: "validate the project",
      signal: new AbortController().signal,
    });

    if (process.platform !== "darwin") return;
    expect(result).toMatchObject({
      ok: true,
      cwd: workspace,
      sandbox: "isolated_validation_no_network",
    });
  });

  test("isolated validation removes artifact symlinks instead of verifying them", async () => {
    const root = mkdtempSync(join(tmpdir(), "btcc-r3-command-validation-link-"));
    roots.push(root);
    const data = join(root, "data");
    const workspace = join(root, "workspace");
    const authority = join(workspace, "secret.txt");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(authority, "authority");
    const result = await executeGuidedCommandCall({
      call: {
        name: "run_command",
        rawArguments: "{}",
        args: {
          command: `ln -s ${JSON.stringify(authority)} "$BUTLER_ARTIFACTS_DIR/leak.txt"`,
          state_effect: "validation",
          validation_suite: "artifact-boundary",
          output_paths: ["$BUTLER_ARTIFACTS_DIR/leak.txt"],
        },
      },
      accessMode: "full_access",
      butlerData: data,
      workspacePath: workspace,
      originalRequest: "validate without publishing links",
      signal: new AbortController().signal,
    });

    if (process.platform !== "darwin") return;
    expect(result).toMatchObject({ ok: true });
    expect(result).not.toHaveProperty("artifacts");
    const artifactBase = join(data, "artifacts", "generated");
    for (const directory of readdirSync(artifactBase)) {
      const candidate = join(artifactBase, directory, "leak.txt");
      expect(existsSync(candidate)).toBe(false);
      if (existsSync(candidate)) expect(lstatSync(candidate).isSymbolicLink()).toBe(false);
    }
  });

  test("published validation artifacts cannot be changed by background descendants", async () => {
    const root = mkdtempSync(join(tmpdir(), "btcc-r3-command-validation-background-"));
    roots.push(root);
    const data = join(root, "data");
    const workspace = join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    const result = await executeGuidedCommandCall({
      call: {
        name: "run_command",
        rawArguments: "{}",
        args: {
          command: [
            "printf good > \"$BUTLER_ARTIFACTS_DIR/result.txt\"",
            "(sleep 0.2; printf bad > \"$BUTLER_ARTIFACTS_DIR/result.txt\") >/dev/null 2>&1 &",
          ].join("; "),
          state_effect: "validation",
          validation_suite: "background-boundary",
          output_paths: ["$BUTLER_ARTIFACTS_DIR/result.txt"],
        },
      },
      accessMode: "full_access",
      butlerData: data,
      workspacePath: workspace,
      originalRequest: "publish stable validation evidence",
      signal: new AbortController().signal,
    });

    if (process.platform !== "darwin") return;
    expect(result).toMatchObject({ ok: true });
    const [artifact] = (result as { artifacts?: Array<{ path: string }> }).artifacts ?? [];
    expect(artifact?.path).toBeString();
    const publishedPath = join(data, artifact!.path);
    expect(readFileSync(publishedPath, "utf8")).toBe("good");
    await Bun.sleep(500);
    expect(readFileSync(publishedPath, "utf8")).toBe("good");
    expect(lstatSync(publishedPath).isFile()).toBe(true);
  });

  test("isolated validation cannot mutate the authoritative workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "btcc-r3-command-validation-source-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    const target = join(workspace, "source.txt");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(target, "original");
    const result = await executeGuidedCommandCall({
      call: {
        name: "run_command",
        rawArguments: "{}",
        args: {
          command: `printf compromised > ${JSON.stringify(target)}`,
          state_effect: "validation",
          validation_suite: "source-boundary",
        },
      },
      accessMode: "full_access",
      butlerData: join(root, "data"),
      workspacePath: workspace,
      originalRequest: "validate without changing source",
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({ ok: false });
    expect(String(await Bun.file(target).text())).toBe("original");
  });

  test("falls back to the read-only boundary when writable validation is not admitted", async () => {
    const root = mkdtempSync(join(tmpdir(), "btcc-r3-command-validation-denied-"));
    roots.push(root);
    const execute = async (
      args: Record<string, unknown>,
      accessMode: "full_access" | "read_only",
    ) =>
      await executeGuidedCommandCall({
        call: { name: "run_command", rawArguments: "{}", args },
        accessMode,
        butlerData: join(root, "data"),
        workspacePath: root,
        originalRequest: "validate the project",
        signal: new AbortController().signal,
      });

    const readOnlyTarget = join(root, "read-only-forbidden.txt");
    expect((await execute({
      command: "printf blocked > read-only-forbidden.txt",
      state_effect: "validation",
      validation_suite: "unit-tests",
    }, "read_only")) as Record<string, unknown>).toMatchObject({ ok: false });
    expect(existsSync(readOnlyTarget)).toBe(false);

    const missingSuiteTarget = join(root, "missing-suite-forbidden.txt");
    expect((await execute({
      command: "printf blocked > missing-suite-forbidden.txt",
      state_effect: "validation",
    }, "full_access")) as Record<string, unknown>).toMatchObject({ ok: false });
    expect(existsSync(missingSuiteTarget)).toBe(false);
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
