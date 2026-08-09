import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeGuidedReadOnlyCommand } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-read-only-command.ts";
import { executeGuidedCommandCall } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-command-execution.ts";
import { prepareGuidedCommandEffect } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-command-effect.ts";
import { createGuidedToolExecutionBoundary } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-tool-execution-boundary.ts";
import { createGuidedEffectService } from
  "../../packages/butler-agent/src/agent/btcc/effects/index.ts";
import type { DurableWorkService } from
  "../../packages/butler-agent/src/agent/btcc/work/index.ts";
import { SqliteGuidedEffectJournal } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/index.ts";
import { BTCC_SUCCESSOR_SCHEMA } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/schema.ts";
import { runCommandToolDefinition } from
  "../../packages/butler-agent/src/agent/tools/run-command/run_command/definition.ts";
import { reviewedWork } from "./support/guided-effect-test-fixture.ts";

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

  test("routes remote observation through the reviewed full-access effect boundary", async () => {
    const root = mkdtempSync(join(tmpdir(), "btcc-r3-remote-observation-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    const prepared = await prepareGuidedCommandEffect({
      args: {
        command: `${JSON.stringify(process.execPath)} -e 'process.stdout.write(process.env.HOME || "")'`,
        summary: "조회: 원격 실행 환경",
        state_effect: "remote_observation",
      },
      butlerData: join(root, "data"),
      workspacePath: workspace,
      originalRequest: "inspect a remote service over SSH",
    });
    expect(prepared.target).toBe("remote-observation-command:.");
    expect(prepared.input.state_effect).toBe("remote_observation");

    const db = new Database(":memory:");
    db.exec(BTCC_SUCCESSOR_SCHEMA);
    try {
      const service = createGuidedEffectService(new SqliteGuidedEffectJournal(db));
      const commandCall = {
        name: "run_command",
        args: prepared.input,
        rawArguments: JSON.stringify(prepared.input),
      };
      const boundary = (accessMode: "full_access" | "read_only") =>
        createGuidedToolExecutionBoundary({
          durableWork: {
            boundWorkForTurn: async () => reviewedWork(),
          } as unknown as DurableWorkService,
          workScope: { turnId: "turn", sessionId: "session" },
          effectService: service,
          accessMode,
          signal: new AbortController().signal,
          executeCommand: async () => {
            throw new Error("Remote observation escaped the persistent-effect boundary");
          },
          resolvePersistentEffect: async () => prepared,
        });
      const applied = await boundary("full_access")({
        call: commandCall,
        context: { effectOccurrenceId: "remote-observation-full-access" },
        definition: runCommandToolDefinition,
        execute: async () => {
          throw new Error("Remote observation dispatched through the registered tool");
        },
      });
      expect(applied).toMatchObject({
        ok: true,
        effect: "remote_observation",
        sandbox: "full_access_contained",
        command_outcome_observed: true,
        effect_receipt: {
          capability: "run_command_remote_observation",
          target: "remote-observation-command:.",
        },
      });
      expect(String((applied as Record<string, unknown>).stdout))
        .toBe(process.env.HOME ?? "");

      const denied = await boundary("read_only")({
        call: commandCall,
        context: { effectOccurrenceId: "remote-observation-read-only" },
        definition: runCommandToolDefinition,
        execute: async () => {
          throw new Error("Remote observation dispatched through the registered tool");
        },
      });
      expect(denied).toMatchObject({
        ok: false,
        error: {
          code: "effect_access_denied",
          effect_status: "rejected",
        },
      });
    } finally {
      db.close(false);
    }
  });

  test("mutation treats a blank validation suite as omitted at the effect boundary", async () => {
    const root = mkdtempSync(join(tmpdir(), "btcc-r3-command-blank-suite-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    const db = new Database(":memory:");
    db.exec(BTCC_SUCCESSOR_SCHEMA);
    const work = reviewedWork();
    const preparedInputs: Array<Record<string, unknown>> = [];
    const boundary = createGuidedToolExecutionBoundary({
      durableWork: {
        boundWorkForTurn: async () => work,
      } as unknown as DurableWorkService,
      workScope: { turnId: "turn", sessionId: "session" },
      effectService: createGuidedEffectService(
        new SqliteGuidedEffectJournal(db),
      ),
      accessMode: "full_access",
      signal: new AbortController().signal,
      executeCommand: async () => {
        throw new Error("Mutation escaped the persistent-effect boundary");
      },
      async resolvePersistentEffect(call) {
        const prepared = await prepareGuidedCommandEffect({
          args: call.args,
          butlerData: join(root, "data"),
          workspacePath: workspace,
          originalRequest: "create a reviewed marker",
        });
        preparedInputs.push(prepared.input as Record<string, unknown>);
        return prepared;
      },
    });
    const execute = async (
      validationSuite: string,
      output: string,
      occurrenceId: string,
    ) => await boundary({
      call: {
        name: "run_command",
        args: {
          command: `printf marker > ${output}`,
          output_paths: [output],
          state_effect: "mutation",
          validation_suite: validationSuite,
        },
        rawArguments: "{}",
      },
      context: { effectOccurrenceId: occurrenceId },
      definition: runCommandToolDefinition,
      execute: async () => {
        throw new Error("Mutation dispatched through the registered tool");
      },
    });

    try {
      expect(await execute("", "empty.txt", "empty-suite")).toMatchObject({
        ok: true,
        effect_receipt: { capability: "run_command" },
      });
      expect(await execute("  \t ", "whitespace.txt", "whitespace-suite"))
        .toMatchObject({
          ok: true,
          effect_receipt: { capability: "run_command" },
        });
      expect(readFileSync(join(workspace, "empty.txt"), "utf8")).toBe("marker");
      expect(readFileSync(join(workspace, "whitespace.txt"), "utf8"))
        .toBe("marker");
      expect(preparedInputs).toHaveLength(2);
      for (const input of preparedInputs) {
        expect(input).not.toHaveProperty("validation_suite");
      }
      await expect(execute("unit-tests", "rejected.txt", "named-suite"))
        .rejects.toThrow("A persistent command cannot also be a validation suite");
      expect(existsSync(join(workspace, "rejected.txt"))).toBe(false);
    } finally {
      db.close(false);
    }
  });

  test("mutation returns verified generated files as safe artifact evidence", async () => {
    const root = mkdtempSync(join(tmpdir(), "btcc-r3-command-generated-artifact-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    const butlerData = join(root, "data");
    const artifactRoot = join(butlerData, "artifacts", "generated");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(artifactRoot, { recursive: true });
    const prepared = await prepareGuidedCommandEffect({
      args: {
        command: "printf artifact > \"$BUTLER_ARTIFACTS_DIR/result.txt\"",
        output_paths: ["$BUTLER_ARTIFACTS_DIR/result.txt"],
        state_effect: "mutation",
      },
      butlerData,
      workspacePath: workspace,
      originalRequest: "create and attach the result",
    });
    const db = new Database(":memory:");
    db.exec(BTCC_SUCCESSOR_SCHEMA);
    try {
      const outcome = await createGuidedEffectService(
        new SqliteGuidedEffectJournal(db),
      ).execute({
        work: reviewedWork(),
        accessMode: "full_access",
        occurrenceId: "generated-artifact-command",
        signal: new AbortController().signal,
        ...prepared,
      });
      expect(outcome).toMatchObject({
        ok: true,
        status: "applied",
        result: {
          artifacts: [{
            path: "artifacts/generated/result.txt",
            artifact_kind: "file",
            size_bytes: 8,
          }],
        },
      });
      if (!outcome.ok) throw new Error("generated artifact command did not apply");
      expect(JSON.stringify(outcome.result.artifacts)).not.toContain(root);
    } finally {
      db.close(false);
    }
  });

  test("mutation canonicalizes a symlinked workspace before deriving its target", async () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "btcc-r3-command-symlink-root-"));
    roots.push(root);
    const realWorkspace = join(root, "real-workspace");
    const linkedWorkspace = join(root, "linked-workspace");
    mkdirSync(realWorkspace, { recursive: true });
    symlinkSync(realWorkspace, linkedWorkspace, "dir");
    const prepared = await prepareGuidedCommandEffect({
      args: {
        command: "printf canonical > command-result.txt",
        cwd: ".",
        output_paths: ["command-result.txt"],
        state_effect: "mutation",
      },
      butlerData: join(root, "data"),
      workspacePath: linkedWorkspace,
      originalRequest: "create a reviewed command result",
    });
    expect(prepared.target).toBe("workspace-command:.");
    expect(prepared.input.cwd).toBe(".");
    const db = new Database(":memory:");
    db.exec(BTCC_SUCCESSOR_SCHEMA);
    try {
      const outcome = await createGuidedEffectService(
        new SqliteGuidedEffectJournal(db),
      ).execute({
        work: reviewedWork(),
        accessMode: "full_access",
        occurrenceId: "symlinked-workspace-command",
        signal: new AbortController().signal,
        ...prepared,
      });
      expect(outcome).toMatchObject({
        ok: true,
        status: "applied",
        receipt: {
          capability: "run_command",
          sanitizedTarget: "workspace-command:.",
        },
      });
      expect(readFileSync(join(realWorkspace, "command-result.txt"), "utf8"))
        .toBe("canonical");
    } finally {
      db.close(false);
    }
  });

  test("mutation rejects a workspace symlink retargeted after approval", async () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "btcc-r3-command-retarget-"));
    roots.push(root);
    const approvedWorkspace = join(root, "approved-workspace");
    const replacementWorkspace = join(root, "replacement-workspace");
    const linkedWorkspace = join(root, "linked-workspace");
    mkdirSync(approvedWorkspace, { recursive: true });
    mkdirSync(replacementWorkspace, { recursive: true });
    symlinkSync(approvedWorkspace, linkedWorkspace, "dir");
    const prepared = await prepareGuidedCommandEffect({
      args: {
        command: "printf escaped > command-result.txt",
        cwd: ".",
        output_paths: ["command-result.txt"],
        state_effect: "mutation",
      },
      butlerData: join(root, "data"),
      workspacePath: linkedWorkspace,
      originalRequest: "create a reviewed command result",
    });
    expect(prepared.target).toBe("workspace-command:.");
    unlinkSync(linkedWorkspace);
    symlinkSync(replacementWorkspace, linkedWorkspace, "dir");
    const db = new Database(":memory:");
    db.exec(BTCC_SUCCESSOR_SCHEMA);
    try {
      const outcome = await createGuidedEffectService(
        new SqliteGuidedEffectJournal(db),
      ).execute({
        work: reviewedWork(),
        accessMode: "full_access",
        occurrenceId: "retargeted-workspace-command",
        signal: new AbortController().signal,
        ...prepared,
      });
      expect(outcome).toMatchObject({
        ok: false,
        status: "failed",
        error: {
          code: "effect_dispatch_failed",
          message: expect.stringContaining("command_workspace_identity_changed"),
        },
      });
      expect(existsSync(join(approvedWorkspace, "command-result.txt"))).toBe(false);
      expect(existsSync(join(replacementWorkspace, "command-result.txt")))
        .toBe(false);
    } finally {
      db.close(false);
    }
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

  test("the same uncertain command occurrence never dispatches twice", async () => {
    const root = mkdtempSync(join(tmpdir(), "btcc-r3-command-uncertain-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    const prepared = await prepareGuidedCommandEffect({
      args: {
        command: "printf 'once\\n' >> repeated.txt",
        state_effect: "mutation",
      },
      butlerData: join(root, "data"),
      workspacePath: workspace,
      originalRequest: "append one line",
    });
    const db = new Database(":memory:");
    db.exec(BTCC_SUCCESSOR_SCHEMA);
    const journal = new SqliteGuidedEffectJournal(db);
    let crashAfterDispatch = true;
    const service = createGuidedEffectService(journal, {
      faultHook(point) {
        if (crashAfterDispatch && point === "after_dispatch") {
          crashAfterDispatch = false;
          throw new Error("crash after command dispatch");
        }
      },
    });
    const work = reviewedWork({
      actions: [{
        actionKey: "run-reviewed-command",
        description: "Run the reviewed contained command",
        dependencyKeys: [],
        effect: { capability: "workspace mutation", target: "workspace:result" },
      }],
    });
    const execute = (occurrenceId: string) => service.execute({
      work,
      accessMode: "full_access",
      occurrenceId,
      signal: new AbortController().signal,
      ...prepared,
    });

    try {
      await expect(execute("runtime-call-1"))
        .rejects.toThrow("crash after command dispatch");
      expect(readFileSync(join(workspace, "repeated.txt"), "utf8"))
        .toBe("once\n");
      expect(await execute("runtime-call-1")).toMatchObject({
        ok: false,
        status: "uncertain",
        error: { code: "effect_reconciliation_required" },
      });
      expect(readFileSync(join(workspace, "repeated.txt"), "utf8"))
        .toBe("once\n");

      expect(await execute("runtime-call-2")).toMatchObject({
        ok: true,
        status: "applied",
      });
      expect(readFileSync(join(workspace, "repeated.txt"), "utf8"))
        .toBe("once\nonce\n");
    } finally {
      db.close(false);
    }
  });
});
