import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { SessionBindingStore } from "../../packages/butler-agent/src/test-support/harness/session-store.ts";
import { openBtccSqliteStores } from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/index.ts";
import { createGuidedEffectService } from "../../packages/butler-agent/src/agent/btcc/effects/index.ts";
import { createGuidedPersistentEffectResolver } from "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-persistent-effect-resolution.ts";
import { createGuidedToolExecutionBoundary } from "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-tool-execution-boundary.ts";
import { createGuidedToolCallExecutor } from "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-tool-call-execution.ts";
import { ActiveProjectLedgerResolver } from "../../packages/butler-agent/src/integrations/project-ledger/active-project-ledger-reference.ts";
import { createPlatformCommandExecutor } from "../../packages/butler-agent/src/runtime/command/platform-command-executor.ts";
import { admitTurn } from "../../packages/butler-agent/src/agent/btcc/turn/admission/admit-turn.ts";
import {
  bindSessionGitWorktree,
  createWorkspaceReference,
  recoverSessionWorkspaceReference,
} from "../../packages/butler-agent/src/agent/session-workspaces/index.ts";
import { deterministicTargetPath } from "../../packages/butler-agent/src/agent/session-workspaces/path.ts";
import { createFileToolHandlers } from "../../packages/butler-agent/src/agent/tools/file-tools/index.ts";
import { createButlerToolExecutor } from "../../packages/butler-agent/src/agent/tools/butler-tools.ts";
import { createSessionWorkspaceToolHandlers } from "../../packages/butler-agent/src/agent/tools/session-workspace/index.ts";
import { BUTLER_TOOLS } from "../../packages/butler-agent/src/agent/tools/registry.ts";
import { selectButlerToolsForTurn } from "../../packages/butler-agent/src/agent/tools/profiles.ts";
import { createGuidedSessionWorkspaceEffectAdapter } from "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-session-workspace-effect.ts";
import type { CommandExecutor, CommandResult } from "../../packages/butler-agent/src/runtime/command/contracts.ts";

function gitRepository() {
  const root = mkdtempSync(join(tmpdir(), "butler-session-workspace-"));
  const repository = join(root, "repository");
  const data = join(root, "data");
  mkdirSync(repository);
  const git = (args: string[]) => execFileSync("git", args, { cwd: repository, stdio: "ignore" });
  git(["init", "-q"]);
  git(["config", "user.email", "session-workspace@example.test"]);
  git(["config", "user.name", "Session Workspace"]);
  writeFileSync(join(repository, "README.md"), "source\n");
  git(["add", "README.md"]);
  git(["commit", "-qm", "initial"]);
  return { root, repository, data };
}

function initProjectLedger(data: string, projectId: string): string {
  const projectPath = join(data, "project-ledger", "projects", projectId);
  mkdirSync(projectPath, { recursive: true });
  const cli = join(process.cwd(), "packages", "project-ledger", "bin", "project-ledger");
  const result = spawnSync(process.execPath, [cli, "init", "--id", projectId, "--name", projectId, "--project", projectPath, "--json"], {
    env: { ...process.env, BUTLER_DATA: data },
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr || "project-ledger init failed");
  return projectPath;
}

function runLedger(data: string, projectPath: string, args: string[]): void {
  const cli = join(process.cwd(), "packages", "project-ledger", "bin", "project-ledger");
  const result = spawnSync(process.execPath, [cli, ...args, "--project", projectPath, "--json"], {
    env: { ...process.env, BUTLER_DATA: data },
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr || `project-ledger ${args[0]} failed`);
}

function appProjectDatabase(path: string, workspacePath: string): void {
  const db = new Database(path);
  db.run(`
    CREATE TABLE projects (
      id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      workspace_label TEXT NOT NULL,
      safe_path_label TEXT NOT NULL,
      ledger_project_id TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    )
  `);
  db.query(`
    INSERT INTO projects (
      id, display_name, workspace_path, workspace_label, safe_path_label,
      ledger_project_id, archived, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 0, ?)
  `).run(
    "project-1",
    "Source Project",
    workspacePath,
    "Source Project",
    "source-project",
    "project-1",
    new Date().toISOString(),
  );
  db.close();
}

function result(overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    stdout: "",
    stderr: "",
    exitCode: 0,
    timedOut: false,
    cancelled: false,
    durationMs: 0,
    error: null,
    ...overrides,
  };
}

function bindingStore(data: string, workspacePath: string, sessionId = "session-1") {
  const store = new SessionBindingStore(join(data, "runtime", "session-store.sqlite"));
  store.upsert({
    sessionId,
    role: "butler",
    projectId: "project-1",
    workspacePath,
    runtimeAdapterId: "btcc-turn-runtime",
    modelProviderId: "test",
    modelRef: "test/model",
    transportBindings: [],
    metadata: { unrelated: { preserved: true } },
  });
  return store;
}

describe("session-owned Git worktree lifecycle", () => {
  test("creates a worktree and routes same executor writes through the live reference", async () => {
    const fixture = gitRepository();
    const store = bindingStore(fixture.data, fixture.repository);
    const reference = createWorkspaceReference(fixture.repository);
    const sessionHandlers = createSessionWorkspaceToolHandlers({
      butlerData: fixture.data,
      workspaceReference: reference,
      bindingStore: store,
      sessionId: "session-1",
    });
    const fileHandlers = createFileToolHandlers({
      butlerData: fixture.data,
      workspacePath: fixture.repository,
      workspaceReference: reference,
    });

    const bound = await sessionHandlers.bind_session_git_worktree({ name: "bind_session_git_worktree", args: { action: "create", branch: "feature/session" }, rawArguments: "{}" });
    expect(bound).toMatchObject({
      ok: true,
      action: "create",
      branch: "feature/session",
      idempotent: false,
      dirty: false,
    });
    expect(JSON.stringify(bound)).not.toContain(fixture.data);

    const written = await fileHandlers.write_file({ name: "write_file", args: { path: "same-turn.txt", content: "bound\n" }, rawArguments: "{}" });
    expect(written).toMatchObject({ ok: true, path: "same-turn.txt" });
    expect(readFileSync(join(reference.get(), "same-turn.txt"), "utf8")).toBe("bound\n");
    expect(readFileSync(join(fixture.repository, "README.md"), "utf8")).toBe("source\n");
    writeFileSync(join(reference.get(), "rebound-list.txt"), "rebound\n");
    const listed = await fileHandlers.list_files({ name: "list_files", args: { root: "." }, rawArguments: "{}" });
    expect(listed).toMatchObject({ ok: true });
    expect((listed as { files?: Array<{ path?: string; bytes?: number }> }).files)
      .toContainEqual({ path: "rebound-list.txt", bytes: 8 });
    const reread = await fileHandlers.read_file({ name: "read_file", args: { path: "rebound-list.txt" }, rawArguments: "{}" });
    expect(reread).toMatchObject({ ok: true, path: "rebound-list.txt", content: "rebound\n" });
    expect(store.getBySessionId("session-1")?.metadata?.sessionWorkspace).toMatchObject({
      schema: "butler.session-workspace-binding.v1",
      ownership: "session",
      branch: "feature/session",
    });
  });

  test("registered executor routes file, command, and automatic Ledger evidence through the rebound workspace", async () => {
    const fixture = gitRepository();
    const store = bindingStore(fixture.data, fixture.repository);
    const reference = createWorkspaceReference(fixture.repository);
    const ledgerPath = initProjectLedger(fixture.data, "project-1");
    const appMessageDbPath = join(fixture.root, "app-message.sqlite");
    appProjectDatabase(appMessageDbPath, fixture.repository);
    runLedger(fixture.data, ledgerPath, [
      "work",
      "create",
      "--id",
      "W-LIVE-WORKSPACE",
      "--title",
      "Live workspace evidence",
      "--status",
      "in_progress",
      "--spec-exemption",
      "--acceptance-exemption",
    ]);
    const executor = createButlerToolExecutor({
      butlerHome: process.cwd(),
      butlerData: fixture.data,
      appMessageDbPath,
      workspacePath: fixture.repository,
      sessionId: "session-1",
      projectId: "project-1",
      workspaceReference: reference,
      sessionBindingStore: store,
    });

    const bound = await executor({
      name: "bind_session_git_worktree",
      args: { action: "create", branch: "feature/executor" },
      rawArguments: "{}",
    });
    expect(bound).toMatchObject({ ok: true, source_dirty: false });
    const reboundPath = reference.get();

    const written = await executor({
      name: "write_file",
      args: { path: "executor.txt", content: "executor-write\n" },
      rawArguments: "{}",
    });
    expect(written).toMatchObject({ ok: true, path: "executor.txt" });
    const command = await executor({
      name: "run_command",
      args: { command: "printf executor-command > command.txt" },
      rawArguments: "{}",
    });
    expect(command).toMatchObject({ ok: true });
    expect(readFileSync(join(reboundPath, "executor.txt"), "utf8")).toBe("executor-write\n");
    expect(readFileSync(join(reboundPath, "command.txt"), "utf8")).toBe("executor-command");
    expect(readFileSync(join(fixture.repository, "README.md"), "utf8")).toBe("source\n");

    const completed = await executor({
      name: "project_ledger_work_complete",
      args: {
        id: "W-LIVE-WORKSPACE",
        validation: "same-turn executor validation",
        review: "same-turn executor review",
        report: "same-turn executor report",
        code_commit: "auto",
      },
      rawArguments: "{}",
    }) as Record<string, any>;
    expect(completed.ok).toBe(true);
    const evidence = JSON.parse(String(completed.data.codeCommits)) as Array<Record<string, string>>;
    expect(evidence[0]).toMatchObject({
      repo: basename(reboundPath),
      branch: "feature/executor",
    });
    expect(evidence[0]?.hash).toBe(execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
      cwd: reboundPath,
      encoding: "utf8",
    }).trim());
  });

  test("selects a linked worktree and repeats idempotently", async () => {
    const fixture = gitRepository();
    const external = join(fixture.root, "external-worktree");
    execFileSync("git", ["worktree", "add", "-b", "feature/select", external, "HEAD"], {
      cwd: fixture.repository,
      stdio: "ignore",
    });
    writeFileSync(join(external, "dirty-target.txt"), "target-dirty\n");
    const store = bindingStore(fixture.data, fixture.repository);
    const reference = createWorkspaceReference(fixture.repository);
    const first = await bindSessionGitWorktree({
      action: "select",
      branch: "feature/select",
      sessionId: "session-1",
      butlerData: fixture.data,
      bindingStore: store,
      workspaceReference: reference,
    });
    const second = await bindSessionGitWorktree({
      action: "select",
      branch: "feature/select",
      sessionId: "session-1",
      butlerData: fixture.data,
      bindingStore: store,
      workspaceReference: reference,
    });
    expect(first).toMatchObject({ ok: true, action: "select", idempotent: false, dirty: true, source_dirty: false });
    expect(second).toMatchObject({ ok: true, action: "select", idempotent: true, dirty: true, source_dirty: false });
    expect(reference.get()).toBe(realpathSync.native(external));
  });

  test("creates despite dirty source and reports source and target dirtiness without mutation", async () => {
    const fixture = gitRepository();
    writeFileSync(join(fixture.repository, "source-dirty.txt"), "source-dirty\n");
    const store = bindingStore(fixture.data, fixture.repository);
    const reference = createWorkspaceReference(fixture.repository);
    const created = await bindSessionGitWorktree({
      action: "create",
      branch: "feature/dirty-source",
      sessionId: "session-1",
      butlerData: fixture.data,
      bindingStore: store,
      workspaceReference: reference,
    });
    expect(created).toMatchObject({ ok: true, dirty: false, source_dirty: true });
    expect(readFileSync(join(fixture.repository, "source-dirty.txt"), "utf8")).toBe("source-dirty\n");
  });

  test("fails safe for checked-out and missing branches without changing the binding", async () => {
    const fixture = gitRepository();
    const store = bindingStore(fixture.data, fixture.repository);
    const reference = createWorkspaceReference(fixture.repository);
    const checkedOut = await bindSessionGitWorktree({
      action: "create",
      branch: "main",
      sessionId: "session-1",
      butlerData: fixture.data,
      bindingStore: store,
      workspaceReference: reference,
    });
    const missing = await bindSessionGitWorktree({
      action: "select",
      branch: "feature/missing",
      sessionId: "session-1",
      butlerData: fixture.data,
      bindingStore: store,
      workspaceReference: reference,
    });
    expect(checkedOut).toMatchObject({ ok: false, error: { code: "branch_already_checked_out" } });
    expect(missing).toMatchObject({ ok: false, error: { code: "linked_worktree_not_found" } });
    expect(store.getBySessionId("session-1")?.workspacePath).toBe(fixture.repository);
    expect(reference.get()).toBe(fixture.repository);
  });

  test("fails safe for occupied targets, non-repositories, missing Git, and cancellation", async () => {
    const fixture = gitRepository();
    const occupiedTarget = deterministicTargetPath(fixture.data, "session-1", "feature/occupied");
    mkdirSync(occupiedTarget, { recursive: true });
    const store = bindingStore(fixture.data, fixture.repository);
    const reference = createWorkspaceReference(fixture.repository);
    const occupied = await bindSessionGitWorktree({
      action: "create",
      branch: "feature/occupied",
      sessionId: "session-1",
      butlerData: fixture.data,
      bindingStore: store,
      workspaceReference: reference,
    });
    expect(occupied).toMatchObject({ ok: false, error: { code: "worktree_target_occupied" } });
    expect(reference.get()).toBe(fixture.repository);
    expect(store.getBySessionId("session-1")?.workspacePath).toBe(fixture.repository);

    const notRepository = join(fixture.root, "not-a-repository");
    mkdirSync(notRepository);
    const nonRepoStore = bindingStore(fixture.data, notRepository, "nonrepo-session");
    const nonRepoReference = createWorkspaceReference(notRepository);
    const nonRepo = await bindSessionGitWorktree({
      action: "create",
      branch: "feature/nonrepo",
      sessionId: "nonrepo-session",
      butlerData: fixture.data,
      bindingStore: nonRepoStore,
      workspaceReference: nonRepoReference,
    });
    expect(nonRepo).toMatchObject({ ok: false, error: { code: "git_repository_required" } });

    const missingGit: CommandExecutor = {
      execute: async () => result({
        exitCode: null,
        error: { code: "ENOENT", message: "git unavailable" },
      }),
    };
    const missingGitReference = createWorkspaceReference(fixture.repository);
    const missingGitResult = await bindSessionGitWorktree({
      action: "create",
      branch: "feature/no-git",
      sessionId: "session-1",
      butlerData: fixture.data,
      bindingStore: store,
      workspaceReference: missingGitReference,
      commandExecutor: missingGit,
    });
    expect(missingGitResult).toMatchObject({ ok: false, error: { code: "git_not_installed" } });
    expect(missingGitReference.get()).toBe(fixture.repository);

    const controller = new AbortController();
    controller.abort();
    const cancelled = await bindSessionGitWorktree({
      action: "create",
      branch: "feature/cancelled",
      sessionId: "session-1",
      butlerData: fixture.data,
      bindingStore: store,
      workspaceReference: reference,
      signal: controller.signal,
    });
    expect(cancelled).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(reference.get()).toBe(fixture.repository);
  });

  test("reports partial creation and leaves the Git candidate untouched on cancellation", async () => {
    const fixture = gitRepository();
    const store = bindingStore(fixture.data, fixture.repository);
    const reference = createWorkspaceReference(fixture.repository);
    const target = deterministicTargetPath(fixture.data, "session-1", "feature/partial");
    let partial = false;
    const partialExecutor: CommandExecutor = {
      execute: async (request) => {
        const args = request.plan.steps[0].arguments ?? [];
        if (args[0] === "rev-parse") return result({ stdout: `${fixture.repository}\n` });
        if (args[0] === "check-ref-format") return result();
        if (args[0] === "worktree" && args[1] === "list") {
          return result({
            stdout: partial
              ? `worktree ${target}\0HEAD deadbeef\0branch refs/heads/feature/partial\0\0`
              : `worktree ${fixture.repository}\0HEAD deadbeef\0branch refs/heads/main\0\0`,
          });
        }
        if (args[0] === "show-ref") return result({ exitCode: 1 });
        if (args[0] === "worktree" && args[1] === "add") {
          partial = true;
          mkdirSync(target, { recursive: true });
          return result({ exitCode: null, cancelled: true });
        }
        return result();
      },
    };
    const cancelled = await bindSessionGitWorktree({
      action: "create",
      branch: "feature/partial",
      sessionId: "session-1",
      butlerData: fixture.data,
      bindingStore: store,
      workspaceReference: reference,
      commandExecutor: partialExecutor,
    });
    expect(cancelled).toMatchObject({ ok: false, error: { code: "partial_creation" } });
    expect(existsSync(target)).toBe(true);
    expect(reference.get()).toBe(fixture.repository);
    expect(store.getBySessionId("session-1")?.workspacePath).toBe(fixture.repository);
  });

  test("retains a created worktree after binding persistence failure and retries without re-adding it", async () => {
    const fixture = gitRepository();
    const store = bindingStore(fixture.data, fixture.repository);
    const reference = createWorkspaceReference(fixture.repository);
    const failingStore = {
      getBySessionId: (sessionId: string) => store.getBySessionId(sessionId),
      rebindWorkspace: () => {
        throw new Error("sqlite unavailable");
      },
    };
    const failed = await bindSessionGitWorktree({
      action: "create",
      branch: "feature/persist-failure",
      sessionId: "session-1",
      butlerData: fixture.data,
      bindingStore: failingStore,
      workspaceReference: reference,
    });
    expect(failed).toMatchObject({ ok: false, error: { code: "binding_persist_failed" } });
    const target = deterministicTargetPath(fixture.data, "session-1", "feature/persist-failure");
    expect(execFileSync("git", ["-C", fixture.repository, "worktree", "list", "--porcelain"], { encoding: "utf8" })).toContain(target);
    expect(reference.get()).toBe(fixture.repository);
    expect(store.getBySessionId("session-1")?.workspacePath).toBe(fixture.repository);

    const retry = await bindSessionGitWorktree({
      action: "create",
      branch: "feature/persist-failure",
      sessionId: "session-1",
      butlerData: fixture.data,
      bindingStore: store,
      workspaceReference: reference,
    });
    expect(retry).toMatchObject({ ok: true, branch: "feature/persist-failure", idempotent: false });
    expect(reference.get()).toBe(realpathSync.native(target));
  });

  test("fails closed for a removed marked worktree without falling back to the project path", async () => {
    const fixture = gitRepository();
    const external = join(fixture.root, "removed-worktree");
    execFileSync("git", ["worktree", "add", "-b", "feature/removed", external, "HEAD"], {
      cwd: fixture.repository,
      stdio: "ignore",
    });
    const store = bindingStore(fixture.data, fixture.repository);
    const observed = store.getBySessionId("session-1")!;
    store.rebindWorkspace({
      sessionId: "session-1",
      expectedUpdatedAt: observed.updatedAt,
      workspacePath: external,
      metadata: {
        ...(observed.metadata ?? {}),
        sessionWorkspace: {
          schema: "butler.session-workspace-binding.v1",
          ownership: "session",
          repositoryAnchorPath: fixture.repository,
          branch: "feature/removed",
          boundAt: new Date().toISOString(),
        },
      },
    });
    rmSync(external, { recursive: true, force: true });
    const reference = createWorkspaceReference(external);
    const selected = await bindSessionGitWorktree({
      action: "select",
      branch: "feature/removed",
      sessionId: "session-1",
      butlerData: fixture.data,
      bindingStore: store,
      workspaceReference: reference,
    });
    expect(selected).toMatchObject({ ok: false, error: { code: "linked_worktree_not_found" } });
    expect(reference.get()).toBe(external);
    expect(store.getBySessionId("session-1")?.workspacePath).toBe(external);
    expect(store.getBySessionId("session-1")?.metadata?.sessionWorkspace).toMatchObject({ branch: "feature/removed" });
  });

  test("CAS preserves the winner and unrelated metadata", () => {
    const fixture = gitRepository();
    const store = bindingStore(fixture.data, fixture.repository);
    const observed = store.getBySessionId("session-1")!;
    const winner = store.rebindWorkspace({
      sessionId: "session-1",
      expectedUpdatedAt: observed.updatedAt,
      workspacePath: join(fixture.root, "winner"),
      metadata: {
        ...(observed.metadata ?? {}),
        sessionWorkspace: {
          schema: "butler.session-workspace-binding.v1",
          ownership: "session",
          repositoryAnchorPath: fixture.repository,
          branch: "winner",
          boundAt: new Date().toISOString(),
        },
      },
    });
    const loser = store.rebindWorkspace({
      sessionId: "session-1",
      expectedUpdatedAt: observed.updatedAt,
      workspacePath: join(fixture.root, "loser"),
      metadata: { sessionWorkspace: { branch: "loser" } },
    });
    expect(winner.status).toBe("applied");
    expect(loser.status).toBe("changed");
    expect(store.getBySessionId("session-1")?.workspacePath).toBe(join(fixture.root, "winner"));
    expect(store.getBySessionId("session-1")?.metadata?.unrelated).toEqual({ preserved: true });
  });

  test("exports the reviewed tool only on a project tool surface", () => {
    const definition = BUTLER_TOOLS.find((tool) => tool.name === "bind_session_git_worktree");
    expect(definition).toMatchObject({ effectBoundary: "reviewed_persistent" });
    const selected = selectButlerToolsForTurn({
      role: "butler",
      sessionMetadata: { projectId: "project-1" },
      turnMetadata: { accessMode: "full_access", trackingMode: "ledger" },
    });
    expect(selected.some((tool) => tool.name === "bind_session_git_worktree")).toBe(true);
  });

  test("guided persistent-effect adapter dispatches the real lifecycle operation", async () => {
    const fixture = gitRepository();
    const store = bindingStore(fixture.data, fixture.repository);
    const reference = createWorkspaceReference(fixture.repository);
    const adapter = createGuidedSessionWorkspaceEffectAdapter({
      butlerData: fixture.data,
      sessionId: "session-1",
      sessionBindingStore: store,
      workspaceReference: reference,
      target: "session-worktree/create/effect-branch",
    });
    const dispatched = await adapter.dispatch({
      normalizedTarget: "session-worktree/create/effect-branch",
      normalizedInput: { action: "create", branch: "effect-branch" },
      idempotencyKey: "effect-test",
      signal: new AbortController().signal,
    });
    expect(dispatched).toMatchObject({ status: "applied", result: { ok: true, branch: "effect-branch" } });
  });

  test("resumes a started bind journal by reconciling the applied effect after workspace recovery", async () => {
    const fixture = gitRepository();
    const store = bindingStore(fixture.data, fixture.repository);
    const stores = openBtccSqliteStores({
      dbPath: join(fixture.data, "btcc.sqlite"),
      ownerId: "session-workspace-bind-replay",
      storageProfile: "ephemeral",
    });
    const sessionId = "session-1";
    const turnId = "session-workspace-bind-replay-turn";
    const scope = { sessionId, turnId };
    const signal = new AbortController().signal;
    try {
      const turn = await admitTurn({
        kind: "run",
        turnId,
        sessionId,
        triggerKey: "session-workspace-bind-replay-trigger",
        message: {
          messageId: "session-workspace-bind-replay-message",
          content: "Create the reviewed session worktree.",
        },
        modelSelection: {
          provider: "openai",
          model: "gpt-5.6-sol",
          reasoningEffort: "low",
          controls: { accessMode: "full_access" },
          controlsHash: "session-workspace-bind-replay-controls",
        },
        context: {
          userRef: "session-workspace-bind-replay-user",
          profileRefs: [],
          recentFeedbackRefs: [],
          mandatoryHotCacheRefs: [],
          optionalHotCacheRefs: [],
          baselineObservationScopeRefs: [`workspace:${fixture.repository}`],
          executionPolicy: {
            role: "butler",
            accessMode: "full_access",
            trackingMode: "local",
            requiredNativeToolProfiles: ["workspace"],
            requiredNativeTools: [],
            workspacePath: fixture.repository,
          },
        },
      }, stores.admission, stores.turns);
      await stores.durableWork.replacePlan({
        ...scope,
        mutationCallId: "bind-replay-plan",
        startNew: true,
        objective: "Bind the session worktree through the reviewed effect path.",
        actions: [{
          actionKey: "bind-session-worktree",
          description: "Create and bind the requested session worktree.",
          dependencyKeys: [],
          effect: {
            capability: "bind_session_git_worktree",
            target: "session-worktree/create/feature/replay",
          },
        }],
        checks: ["The session binding and active workspace reference agree."],
      });
      const reviewed = await stores.durableWork.recordReview({
        ...scope,
        mutationCallId: "bind-replay-plan-review",
        subject: "plan",
        verdict: "accept",
        summary: "The reviewed session worktree effect is authorized.",
        corrections: [],
      });
      expect(reviewed.latestPlanReview?.verdict).toBe("accept");

      const faultPoints: string[] = [];
      const makeExecutor = (
        workspaceReference: ReturnType<typeof createWorkspaceReference>,
        options: { faultAfterDispatch?: boolean; forceInitialDispatch?: boolean } = {},
      ) => {
        const effectService = createGuidedEffectService(
          stores.guidedEffectJournal,
          options.faultAfterDispatch
            ? {
                faultHook(point) {
                  faultPoints.push(point);
                  if (point === "after_dispatch") {
                    throw new Error("simulated crash after bind effect dispatch");
                  }
                },
              }
            : {},
        );
        const resolveBase = createGuidedPersistentEffectResolver({
          butlerHome: fixture.root,
          butlerData: fixture.data,
          appMessageDbPath: join(fixture.root, "app-message.sqlite"),
          workspacePath: fixture.repository,
          workspaceReference,
          sessionId,
          sessionBindingStore: store,
          trackingMode: "local",
          projectLedgerResolver: new ActiveProjectLedgerResolver(),
          effectJournal: stores.guidedEffectJournal,
          originalRequest: "Create the reviewed session worktree.",
        });
        let initialReconcile = true;
        const resolvePersistentEffect = async (...args: Parameters<typeof resolveBase>) => {
          const resolved = await resolveBase(...args);
          if (!options.forceInitialDispatch || !initialReconcile || !resolved || "error" in resolved) {
            return resolved;
          }
          initialReconcile = false;
          return {
            ...resolved,
            adapter: {
              ...resolved.adapter,
              async reconcile(_input: Parameters<typeof resolved.adapter.reconcile>[0]) {
                return { status: "not_applied" as const };
              },
            },
          };
        };
        const executionBoundary = createGuidedToolExecutionBoundary({
          durableWork: stores.durableWork,
          workScope: scope,
          effectService,
          accessMode: "full_access",
          signal,
          executeCommand: async () => ({ ok: true }),
          resolvePersistentEffect,
        });
        const executeButlerTool = createButlerToolExecutor({
          butlerHome: fixture.root,
          butlerData: fixture.data,
          appMessageDbPath: join(fixture.root, "app-message.sqlite"),
          workspacePath: fixture.repository,
          workspaceReference,
          sessionId,
          turnId,
          originChatId: sessionId,
          turnContext: "Create the reviewed session worktree.",
          executionBoundary,
          sessionBindingStore: store,
        });
        return createGuidedToolCallExecutor({
          turn,
          signal,
          workScope: scope,
          authorizedNames: new Set(["bind_session_git_worktree"]),
          visibleNames: new Set(["bind_session_git_worktree"]),
          describedToolIds: new Set(),
          durableWork: stores.durableWork,
          toolJournal: stores.guidedToolJournal,
          executeButlerTool,
        });
      };
      const call = {
        name: "bind_session_git_worktree",
        args: { action: "create", branch: "feature/replay" },
        rawArguments: JSON.stringify({ action: "create", branch: "feature/replay" }),
        providerCallId: "bind-replay-provider-call",
        signal,
      } as const;

      const firstReference = createWorkspaceReference(fixture.repository);
      const firstExecutor = makeExecutor(firstReference, {
        faultAfterDispatch: true,
        forceInitialDispatch: true,
      });
      const originalFinish = stores.guidedToolJournal.finish;
      stores.guidedToolJournal.finish = () => {};
      let firstResult: unknown;
      try {
        firstResult = await firstExecutor.executeTool(call);
      } finally {
        stores.guidedToolJournal.finish = originalFinish;
      }
      expect(faultPoints).toContain("after_dispatch");
      expect(firstResult).toMatchObject({ ok: false });
      expect(stores.guidedToolJournal.list(turnId)).toHaveLength(1);
      expect(stores.guidedToolJournal.list(turnId)[0]?.status).toBe("started");
      const work = await stores.durableWork.boundWorkForTurn(turnId);
      expect(work).not.toBeNull();
      expect(stores.guidedEffectJournal.listForWork(work!.workId)).toMatchObject([
        { capability: "bind_session_git_worktree", status: "dispatching" },
      ]);
      const binding = store.getBySessionId(sessionId);
      if (!binding) {
        throw new Error("session workspace binding was not persisted after dispatch");
      }
      const boundPath = binding.workspacePath;
      expect(boundPath).not.toBe(fixture.repository);
      expect(firstReference.get()).toBe(boundPath);

      const recovered = await recoverSessionWorkspaceReference({
        sessionId,
        bindingStore: store,
        projectWorkspacePath: fixture.repository,
        commandExecutor: createPlatformCommandExecutor(),
        signal,
      });
      expect(recovered.validation).toMatchObject({ ok: true, path: boundPath });
      const resumedExecutor = makeExecutor(recovered.workspaceReference);
      const resumed = await resumedExecutor.executeTool(call);
      expect(resumed).toMatchObject({
        ok: true,
        branch: "feature/replay",
        idempotent: true,
        effect_receipt: { replayed: false },
      });
      expect(recovered.workspaceReference.get()).toBe(boundPath);
      expect(stores.guidedToolJournal.list(turnId)[0]?.status).toBe("completed");
    } finally {
      stores.close();
      store.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
