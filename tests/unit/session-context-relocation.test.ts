import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { SessionBindingStore } from "../../packages/butler-agent/src/test-support/harness/session-store.ts";
import { prepareWorkspaceForRelocation, discardRelocationWorkspace } from "../../packages/butler-agent/src/agent/session-workspaces/index.ts";

test("context CAS changes all project identities and preserves model, transport and history identity", () => {
  const dir = mkdtempSync(join(tmpdir(), "butler-relocation-cas-"));
  const store = new SessionBindingStore(join(dir, "sessions.sqlite"));
  try {
    const before = store.upsert({ sessionId: "session-1", role: "butler", projectId: "old", appProjectId: "app-old", ledgerProjectId: "ledger-old", workspacePath: dir, runtimeAdapterId: "btcc-turn-runtime", modelProviderId: "test", modelRef: "test/model", providerThreadRef: "history-1", transportBindings: [{ transport: "app", accountId: "default", peerId: "conversation-1" }], metadata: { unrelated: true } });
    const input = { sessionId: before.sessionId, expectedUpdatedAt: before.updatedAt, operationId: "relocation-1", workspacePath: join(dir, "next"), projectId: "new", appProjectId: "app-new", ledgerProjectId: "ledger-new", metadata: { ...before.metadata, appSessionKind: "project" } };
    const changed = store.compareAndSetExecutionContext(input);
    expect(changed.status).toBe("applied");
    const after = store.getBySessionId(before.sessionId)!;
    expect([after.projectId, after.appProjectId, after.ledgerProjectId]).toEqual(["new", "app-new", "ledger-new"]);
    expect(after.providerThreadRef).toBe(before.providerThreadRef);
    expect(after.transportBindings).toEqual(before.transportBindings);
    expect(after.modelRef).toBe(before.modelRef);
    expect(store.compareAndSetExecutionContext(input)).toEqual(changed);
    expect(store.compareAndSetExecutionContext({ ...input, operationId: "stale", workspacePath: dir }).status).toBe("changed");
    expect(store.getBySessionId(before.sessionId)).toEqual(after);
    const general = store.compareAndSetExecutionContext({ ...input, operationId: "relocation-2", expectedUpdatedAt: after.updatedAt, workspacePath: dir, projectId: null, appProjectId: null, ledgerProjectId: null });
    expect(general.status).toBe("applied");
    expect(store.getBySessionId(before.sessionId)?.appProjectId).toBeUndefined();
    expect(store.getBySessionId(before.sessionId)?.ledgerProjectId).toBeUndefined();
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("relocation prepares a separate Git worktree and never modifies original dirty files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "butler-relocation-git-"));
  const repository = join(dir, "project");
  const data = join(dir, "data");
  mkdirSync(repository); mkdirSync(data);
  const git = (args: string[]) => execFileSync("git", args, { cwd: repository, stdio: "ignore" });
  try {
    git(["init", "-q"]); git(["config", "user.name", "Relocation test"]); git(["config", "user.email", "relocation@example.test"]);
    writeFileSync(join(repository, "README.md"), "committed\n"); git(["add", "README.md"]); git(["commit", "-qm", "initial"]);
    writeFileSync(join(repository, "README.md"), "user edit\n");
    const input = { sessionId: "session-1", operationId: "operation-1", butlerData: data, projectPath: repository };
    let recordedBeforeCreation = false;
    const prepared = await prepareWorkspaceForRelocation({ ...input, onPrepared: workspace => {
      recordedBeforeCreation = !existsSync(workspace.workspacePath);
      expect(workspace.operationId).toBe(input.operationId);
    } });
    expect(recordedBeforeCreation).toBe(true);
    expect(prepared.workspacePath).not.toBe(repository);
    expect(readFileSync(join(prepared.workspacePath, "README.md"), "utf8")).toBe("committed\n");
    expect(readFileSync(join(repository, "README.md"), "utf8")).toBe("user edit\n");
    expect((await prepareWorkspaceForRelocation(input)).workspacePath).toBe(prepared.workspacePath);
    expect(await discardRelocationWorkspace(prepared)).toBe(true);
    expect(existsSync(prepared.workspacePath)).toBe(false);
    expect(readFileSync(join(repository, "README.md"), "utf8")).toBe("user edit\n");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
