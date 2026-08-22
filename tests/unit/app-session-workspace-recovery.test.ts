/// <reference types="bun" />

import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { createTestAppServer } from "../../packages/butler-agent/src/test-support/app-server.ts";
import { SessionBindingStore } from "../../packages/butler-agent/src/test-support/harness/session-store.ts";
import { sessionHintForRow } from "../../packages/butler-agent/src/gateways/app/domain/sessions/index.ts";
import {
  bindSessionGitWorktree,
  createWorkspaceReference,
  recoverSessionWorkspaceReference,
  resolveSessionWorkspaceAuthority,
  validateSessionWorkspaceAuthority,
} from "../../packages/butler-agent/src/agent/session-workspaces/index.ts";
import { createButlerToolExecutor as createAgentToolExecutor } from "../../packages/butler-agent/src/agent/tools/butler-tools.ts";
import {
  removeServiceState,
  writeServiceState,
} from "../../packages/butler-agent/src/operations/service/native-service-supervisor.ts";
import { createPlatformCommandExecutor } from "../../packages/butler-agent/src/runtime/command/platform-command-executor.ts";
import type { ButlerServiceClient } from "../../packages/butler-agent/src/gateways/core/client.ts";

test("Agent relaunch preserves its worktree while App projects safe binding facts", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-app-worktree-relaunch-"));
  const dbPath = join(root, "app.sqlite");
  const bindingStorePath = join(root, "runtime", "session-store.sqlite");
  let bindingStore = new SessionBindingStore(bindingStorePath);
  let server: ReturnType<typeof createTestAppServer> | undefined;
  let relaunched: ReturnType<typeof createTestAppServer> | undefined;
  try {
    const serviceClient = queueClient();
    server = createTestAppServer({
      dbPath,
      butlerData: root,
      butlerHome: process.cwd(),
      projectWorkspaceRoot: join(root, "projects"),
      serviceClient,
      port: 0,
    });
    const project = await postJson(`${server.url}projects`, {
      source: "scratch",
      display_name: "Relaunch project",
    });
    const projectId = project.data.project.id as string;
    const projectRow = server.store.db
      .query<{ workspace_path: string }, [string]>(
        "SELECT workspace_path FROM projects WHERE id = ?",
      )
      .get(projectId);
    expect(projectRow?.workspace_path).toBeTruthy();
    const sourcePath = projectRow!.workspace_path;
    initRepository(sourcePath);
    const session = await postJson(`${server.url}sessions`, {
      kind: "project",
      project_id: projectId,
      title: "Relaunch session",
    });
    const chatId = session.data.session.id as string;
    const runtimeSessionId = sessionHintForRow(chatId);
    bindingStore.upsert({
      sessionId: runtimeSessionId,
      role: "butler",
      projectId,
      workspacePath: sourcePath,
      runtimeAdapterId: "btcc-turn-runtime",
      modelProviderId: "openai",
      modelRef: "openai/test",
      transportBindings: [{
        transport: "app",
        accountId: "local",
        peerId: chatId,
      }],
      metadata: { source: "app-relaunch-test" },
    });

    const initialReference = createWorkspaceReference(sourcePath);
    const executor = createAgentToolExecutor({
      butlerHome: process.cwd(),
      butlerData: root,
      workspacePath: sourcePath,
      sessionId: runtimeSessionId,
      projectId,
      workspaceReference: initialReference,
      sessionBindingStore: bindingStore,
    });
    const bound = await executor({
      name: "bind_session_git_worktree",
      args: { action: "create", branch: "feature/relaunch" },
      rawArguments: "{}",
    }) as Record<string, any>;
    expect(bound.ok).toBe(true);
    const marked = bindingStore.getBySessionId(runtimeSessionId)!;
    expect(marked.workspacePath).not.toBe(sourcePath);
    expect(marked.metadata?.sessionWorkspace).toMatchObject({
      schema: "butler.session-workspace-binding.v1",
      ownership: "session",
      branch: "feature/relaunch",
    });
    expect(
      gitText(marked.workspacePath, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    ).toBe("feature/relaunch");

    const firstView = await getJson(
      `${server.url}session-view?session_id=${encodeURIComponent(chatId)}`,
    );
    expect(firstView.data.branch).toMatchObject({
      workspace_binding: "session_worktree",
      branch_name: "feature/relaunch",
      workspace_label: "session-worktree/feature/relaunch",
      workspace_status: "available",
      dirty: false,
    });
    expect(JSON.stringify(firstView.data.branch)).not.toContain(sourcePath);

    // The registered executor must consume the same live reference that the
    // native bind tool updated. Project Ledger keeps the App project identity
    // but collects commit evidence from that rebound workspace.
    const ledgerPath = initProjectLedger(root, projectId);
    runLedger(root, ledgerPath, [
      "work",
      "create",
      "--id",
      "W-APP-RELAUNCH",
      "--title",
      "App relaunch workspace evidence",
      "--status",
      "in_progress",
      "--spec-exemption",
      "--acceptance-exemption",
    ]);
    const firstWrite = await executor({
      name: "write_file",
      args: { path: "relaunch-before.txt", content: "before-relaunch\n" },
      rawArguments: "{}",
    });
    expect(firstWrite).toMatchObject({ ok: true, path: "relaunch-before.txt" });
    const firstCommand = await executor({
      name: "run_command",
      args: { command: "printf after-bind > relaunch-command.txt" },
      rawArguments: "{}",
    });
    expect(firstCommand).toMatchObject({ ok: true });
    expect(existsSync(join(marked.workspacePath, "relaunch-before.txt"))).toBe(true);
    expect(existsSync(join(marked.workspacePath, "relaunch-command.txt"))).toBe(true);
    expect(existsSync(join(sourcePath, "relaunch-before.txt"))).toBe(false);
    const completed = await executor({
      name: "project_ledger_work_complete",
      args: {
        id: "W-APP-RELAUNCH",
        validation: "relaunch executor validation",
        review: "relaunch executor review",
        report: "relaunch executor report",
        code_commit: "auto",
      },
      rawArguments: "{}",
    }) as Record<string, any>;
    expect(completed.ok).toBe(true);
    const commitEvidence = JSON.parse(String(completed.data.codeCommits)) as Array<Record<string, string>>;
    expect(commitEvidence[0]).toMatchObject({
      repo: basename(marked.workspacePath),
      branch: "feature/relaunch",
      hash: gitText(marked.workspacePath, ["rev-parse", "--short=12", "HEAD"]),
    });

    writeServiceState(root, serviceState());
    const queued = await server.store.sendMessage({
      chat_id: chatId,
      text: "queue after bind",
    });
    expect(queued.turn?.id).toBeTruthy();
    expect(bindingStore.getBySessionId(runtimeSessionId)?.workspacePath).toBe(
      marked.workspacePath,
    );

    server.stop();
    server = undefined;
    bindingStore.close();
    bindingStore = new SessionBindingStore(bindingStorePath);
    relaunched = createTestAppServer({
      dbPath,
      butlerData: root,
      butlerHome: process.cwd(),
      projectWorkspaceRoot: join(root, "projects"),
      serviceClient: queueClient(),
      port: 0,
    });
    const relaunchedView = await getJson(
      `${relaunched.url}session-summary?session_id=${encodeURIComponent(chatId)}`,
    );
    expect(relaunchedView.data.branch_info).toMatchObject({
      workspace_binding: "session_worktree",
      branch_name: "feature/relaunch",
      workspace_label: "session-worktree/feature/relaunch",
      workspace_status: "available",
      dirty: true,
    });
    expect(JSON.stringify(relaunchedView.data.branch_info)).not.toContain(sourcePath);

    const queuedAfterRelaunch = await relaunched.store.sendMessage({
      chat_id: chatId,
      text: "queue after relaunch",
    });
    expect(queuedAfterRelaunch.queued?.id).toBeTruthy();
    expect(bindingStore.getBySessionId(runtimeSessionId)?.workspacePath).toBe(
      marked.workspacePath,
    );

    // Recompose the real tool executor after the server/store boundary. Its
    // live reference is restored from the marked binding, never the App row.
    const recovered = await recoverSessionWorkspaceReference({
      sessionId: runtimeSessionId,
      bindingStore,
      projectWorkspacePath: sourcePath,
      commandExecutor: createPlatformCommandExecutor(),
    });
    expect(recovered.validation).toMatchObject({ ok: true, path: marked.workspacePath });
    const relaunchedReference = recovered.workspaceReference;
    const relaunchedExecutor = createAgentToolExecutor({
      butlerHome: process.cwd(),
      butlerData: root,
      workspacePath: sourcePath,
      sessionId: runtimeSessionId,
      projectId,
      workspaceReference: relaunchedReference,
      sessionBindingStore: bindingStore,
    });
    const postRelaunchCommand = await relaunchedExecutor({
      name: "run_command",
      args: { command: "printf after-relaunch > relaunch-after.txt" },
      rawArguments: "{}",
    });
    expect(postRelaunchCommand).toMatchObject({ ok: true });
    expect(existsSync(join(marked.workspacePath, "relaunch-after.txt"))).toBe(true);
    expect(existsSync(join(sourcePath, "relaunch-after.txt"))).toBe(false);
    const ledgerRecord = await relaunchedExecutor({
      name: "project_ledger_show",
      args: { id: "W-APP-RELAUNCH", include_body: true },
      rawArguments: "{}",
    }) as Record<string, any>;
    expect(ledgerRecord.ok).toBe(true);
    const persistedEvidence = JSON.parse(String(ledgerRecord.data.codeCommits)) as Array<Record<string, string>>;
    expect(persistedEvidence[0]).toMatchObject({
      repo: basename(marked.workspacePath),
      branch: "feature/relaunch",
    });

    relaunched.stop();
    relaunched = undefined;
    rmSync(marked.workspacePath, { recursive: true, force: true });
    // A different Git repository/branch at the durable path is stale too;
    // summary and ordinary operations must remain unavailable.
    initRepository(marked.workspacePath);
    const staleServer = createTestAppServer({
      dbPath,
      butlerData: root,
      butlerHome: process.cwd(),
      projectWorkspaceRoot: join(root, "projects"),
      port: 0,
    });
    try {
      const staleView = await getJson(
        `${staleServer.url}session-summary?session_id=${encodeURIComponent(chatId)}`,
      );
      expect(staleView.data.branch_info).toMatchObject({
        workspace_binding: "session_worktree",
        workspace_status: "unavailable",
        workspace_label: "session-worktree/feature/relaunch",
        safe_error_code: "session_workspace_unavailable",
      });
      expect(JSON.stringify(staleView.data.branch_info)).not.toContain(
        sourcePath,
      );
    } finally {
      staleServer.stop();
    }
  } finally {
    if (server) server.stop();
    if (relaunched) relaunched.stop();
    removeServiceState(root, "butler-main");
    bindingStore.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("stale marked worktrees block ordinary tools and explicit bind can recover", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-session-workspace-recovery-"));
  const sourcePath = join(root, "source");
  const bindingStore = new SessionBindingStore(join(root, "runtime", "session-store.sqlite"));
  const sessionId = "butler/recovery-test";
  try {
    initRepository(sourcePath);
    bindingStore.upsert({
      sessionId,
      role: "butler",
      workspacePath: sourcePath,
      runtimeAdapterId: "btcc-turn-runtime",
      modelProviderId: "openai",
      modelRef: "openai/test",
      transportBindings: [],
      metadata: {},
    });
    const reference = createWorkspaceReference(sourcePath);
    const created = await bindSessionGitWorktree({
      action: "create",
      branch: "feature/stale",
      sessionId,
      butlerData: root,
      bindingStore,
      workspaceReference: reference,
    });
    expect(created.ok).toBe(true);
    const staleBinding = bindingStore.getBySessionId(sessionId)!;
    const stalePath = staleBinding.workspacePath;
    expect(existsSync(stalePath)).toBe(true);
    rmSync(stalePath, { recursive: true, force: true });
    // A different repository at the marked path is stale even when it is a
    // valid Git checkout; the marker's anchor and branch remain authoritative.
    initRepository(stalePath);

    const authority = resolveSessionWorkspaceAuthority({ binding: staleBinding });
    expect(authority.kind).toBe("session_worktree");
    if (authority.kind !== "session_worktree") throw new Error("expected marked authority");
    const validation = await validateSessionWorkspaceAuthority({
      authority,
      commandExecutor: createPlatformCommandExecutor(),
    });
    expect(validation).toEqual({
      ok: false,
      code: "session_workspace_unavailable",
    });

    const recovered = await recoverSessionWorkspaceReference({
      sessionId,
      bindingStore,
      projectWorkspacePath: sourcePath,
      commandExecutor: createPlatformCommandExecutor(),
    });
    expect(recovered.validation).toEqual({
      ok: false,
      code: "session_workspace_unavailable",
    });
    const executor = createAgentToolExecutor({
      butlerHome: process.cwd(),
      butlerData: root,
      workspacePath: stalePath,
      workspaceReference: recovered.workspaceReference,
      sessionId,
      sessionBindingStore: bindingStore,
      currentToolNames: [
        "read_file",
        "write_file",
        "bind_session_git_worktree",
      ],
    });
    await expect(executor({
      name: "write_file",
      rawArguments: "{}",
      args: { path: "blocked.txt", content: "must not write" },
    })).rejects.toThrow("session_workspace_unavailable");
    expect(existsSync(join(stalePath, "blocked.txt"))).toBe(false);

    const rebound = await executor({
      name: "bind_session_git_worktree",
      rawArguments: "{}",
      args: { action: "create", branch: "feature/recovered" },
    });
    expect(rebound).toMatchObject({
      ok: true,
      branch: "feature/recovered",
    });
    const write = await executor({
      name: "write_file",
      rawArguments: "{}",
      args: { path: "recovered.txt", content: "recovered" },
    });
    expect(write).toMatchObject({ ok: true, path: "recovered.txt" });
    const recoveredPath = bindingStore.getBySessionId(sessionId)!.workspacePath;
    expect(recoveredPath).not.toBe(stalePath);
  } finally {
    bindingStore.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("malformed and stale repository anchors remain unavailable without fallback", async () => {
  const binding = {
    sessionId: "butler/malformed",
    workspacePath: "/private/session-worktree",
    updatedAt: "2026-08-09T00:00:00.000Z",
    metadata: {
      sessionWorkspace: {
        schema: "butler.session-workspace-binding.v1",
        ownership: "session",
        repositoryAnchorPath: "/private/non-repository",
        branch: "feature/malformed",
        boundAt: "2026-08-09T00:00:00.000Z",
      },
    },
  };
  const authority = resolveSessionWorkspaceAuthority({
    binding,
    projectWorkspacePath: "/project/source",
  });
  expect(authority).toMatchObject({
    kind: "session_worktree",
    workspacePath: "/private/session-worktree",
  });
  if (authority.kind !== "session_worktree") throw new Error("expected authority");
  expect(await validateSessionWorkspaceAuthority({
    authority,
    commandExecutor: createPlatformCommandExecutor(),
  })).toEqual({
    ok: false,
    code: "session_workspace_unavailable",
  });

  const malformed = resolveSessionWorkspaceAuthority({
    binding: {
      ...binding,
      metadata: { sessionWorkspace: { schema: "wrong" } },
    },
    projectWorkspacePath: "/project/source",
  });
  expect(malformed).toEqual({
    kind: "unavailable",
    workspacePath: "/private/session-worktree",
    workspaceLabel: "Session worktree",
    safeErrorCode: "session_workspace_marker_invalid",
  });
});

function initRepository(path: string): void {
  mkdirSync(path, { recursive: true });
  const git = process.env.BUTLER_GIT_EXECUTABLE?.trim() || "git";
  expect(spawnSync(git, ["init"], { cwd: path, encoding: "utf8" }).status).toBe(0);
  expect(spawnSync(git, [
    "-c", "user.email=butler-tests@example.invalid",
    "-c", "user.name=Butler Tests",
    "commit", "--allow-empty", "-m", "initial",
  ], { cwd: path, encoding: "utf8" }).status).toBe(0);
}

function initProjectLedger(data: string, projectId: string): string {
  const projectPath = join(data, "project-ledger", "projects", projectId);
  mkdirSync(projectPath, { recursive: true });
  const cli = join(process.cwd(), "packages", "project-ledger", "bin", "project-ledger");
  const result = spawnSync(process.execPath, [
    cli,
    "init",
    "--id",
    projectId,
    "--name",
    projectId,
    "--project",
    projectPath,
    "--json",
  ], {
    env: { ...process.env, BUTLER_DATA: data },
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr || "project-ledger init failed");
  return projectPath;
}

function runLedger(data: string, projectPath: string, args: string[]): void {
  const cli = join(process.cwd(), "packages", "project-ledger", "bin", "project-ledger");
  const result = spawnSync(process.execPath, [
    cli,
    ...args,
    "--project",
    projectPath,
    "--json",
  ], {
    env: { ...process.env, BUTLER_DATA: data },
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr || `project-ledger ${args[0]} failed`);
}

function gitText(cwd: string, args: string[]): string {
  const git = process.env.BUTLER_GIT_EXECUTABLE?.trim() || "git";
  const result = spawnSync(git, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

function queueClient(): ButlerServiceClient {
  return {
    findAppTurn() {
      return null;
    },
    enqueueAppCancellation() {
      throw new Error("unexpected cancellation");
    },
    enqueueAppTurn(input, metadata = {}) {
      return {
        version: 1,
        queueId: `test-queue-${input.turnId}`,
        envelope: {
          eventId: `test-event-${input.turnId}`,
          transport: "app",
          accountId: "local",
          peer: { kind: "dm", id: input.chatId },
          sender: { id: "app", displayName: "Butler App" },
          message: {
            id: input.messageId,
            text: input.text,
            timestamp: input.timestamp,
          },
          routingHints: {
            sessionId: input.sessionId,
            turnId: input.turnId,
          },
          executionControls: input.executionControls,
        },
        enqueuedAt: new Date().toISOString(),
        attempts: 0,
        metadata,
      };
    },
  };
}

function serviceState() {
  return {
    version: 1 as const,
    supervisor: "native-supervisor" as const,
    serviceId: "butler-main" as const,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    command: process.execPath,
    args: [],
    cwd: process.cwd(),
    stdoutFile: "",
    stderrFile: "",
    restartPolicy: "manual" as const,
  };
}

async function postJson(url: string, body: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  expect(response.status).toBeLessThan(300);
  return data as { data: Record<string, any> };
}

async function getJson(url: string) {
  const response = await fetch(url);
  const data = await response.json();
  expect(response.status).toBe(200);
  return data as { data: Record<string, any> };
}
