#!/usr/bin/env bun

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { SessionBindingStore } from "../../packages/butler-agent/src/test-support/harness/session-store.ts";
import {
  createButlerToolExecutor,
  type ButlerToolExecutor,
} from "../../packages/butler-agent/src/agent/tools/butler-tools.ts";
import {
  createPlatformCommandExecutor,
} from "../../packages/butler-agent/src/runtime/command/platform-command-executor.ts";
import {
  createWorkspaceReference,
  recoverSessionWorkspaceReference,
} from "../../packages/butler-agent/src/agent/session-workspaces/index.ts";
import {
  asRecord,
  assertCommitEvidence,
  commitEvidence,
  createLedgerWork,
  initRepository,
  initializeLedger,
} from "./session-worktree-smoke-support.ts";

const BRANCH = "feature/smoke";
const PROJECT_ID = "smoke-project";
const SESSION_ID = "smoke-session";
const WORK_ID = "W-SMOKE-WORKSPACE";

type SafeSmokeSummary = {
  ok: boolean;
  branch: string;
  binding: "session_worktree";
  same_turn: {
    file: boolean;
    command: boolean;
    ledger_evidence: boolean;
  };
  recovery: {
    store_reopened: boolean;
    reference_validated: boolean;
    command: boolean;
    ledger_evidence: boolean;
  };
  evidence: {
    before_relaunch: boolean;
    after_relaunch: boolean;
  };
};

const REPO_ROOT = resolve(import.meta.dir, "../..");
let tempRoot: string | undefined;
let bindingStore: SessionBindingStore | undefined;
let summary: SafeSmokeSummary | undefined;
let cleanupFailed = false;

try {
  summary = await runSmoke();
} catch {
  process.exitCode = 1;
}

try {
  bindingStore?.close();
} catch {
  cleanupFailed = true;
  process.exitCode = 1;
}
if (tempRoot) {
  try {
    rmSync(tempRoot, { recursive: true, force: true });
  } catch {
    cleanupFailed = true;
    process.exitCode = 1;
  }
}

if (cleanupFailed) {
  summary = undefined;
}
if (summary) {
  process.stdout.write(`${JSON.stringify(summary)}\n`);
} else {
  process.stdout.write('{"ok":false,"error":"session_worktree_smoke_failed"}\n');
}

async function runSmoke(): Promise<SafeSmokeSummary> {
  tempRoot = mkdtempSync(join(tmpdir(), "butler-session-worktree-smoke-"));
  const sourcePath = join(tempRoot, "source");
  const dataPath = join(tempRoot, "data");
  const bindingStorePath = join(tempRoot, "runtime", "session-store.sqlite");
  mkdirSync(dataPath, { recursive: true });

  initRepository(sourcePath);
  initializeLedger(REPO_ROOT, dataPath, PROJECT_ID);
  createLedgerWork({
    repoRoot: REPO_ROOT,
    dataPath,
    projectId: PROJECT_ID,
    workId: WORK_ID,
  });

  bindingStore = new SessionBindingStore(bindingStorePath);
  bindingStore.upsert({
    sessionId: SESSION_ID,
    role: "butler",
    projectId: PROJECT_ID,
    workspacePath: sourcePath,
    runtimeAdapterId: "btcc-turn-runtime",
    modelProviderId: "smoke",
    modelRef: "smoke/model",
    transportBindings: [],
    metadata: { smoke: true },
  });

  const liveReference = createWorkspaceReference(sourcePath);
  const executor = createExecutor({
    dataPath,
    sourcePath,
    liveReference,
  });
  const bound = asRecord(await executor({
    name: "bind_session_git_worktree",
    args: { action: "create", branch: BRANCH },
    rawArguments: "{}",
  }));
  assert(bound.ok === true);

  const markedPath = bindingStore.getBySessionId(SESSION_ID)?.workspacePath;
  assert(typeof markedPath === "string" && markedPath !== sourcePath);

  const fileResult = asRecord(await executor({
    name: "write_file",
    args: { path: "smoke-file.txt", content: "same-turn\n" },
    rawArguments: "{}",
  }));
  assert(fileResult.ok === true);
  assert(readFileSync(join(markedPath, "smoke-file.txt"), "utf8") === "same-turn\n");
  assert(!existsSync(join(sourcePath, "smoke-file.txt")));

  const commandResult = asRecord(await executor({
    name: "run_command",
    args: { command: "printf same-turn > smoke-command.txt" },
    rawArguments: "{}",
  }));
  assert(commandResult.ok === true);
  assert(readFileSync(join(markedPath, "smoke-command.txt"), "utf8") === "same-turn");
  assert(!existsSync(join(sourcePath, "smoke-command.txt")));

  const completed = asRecord(await executor({
    name: "project_ledger_work_complete",
    args: {
      id: WORK_ID,
      validation: "standalone smoke validation",
      review: "standalone smoke review",
      report: "standalone smoke report",
      code_commit: "auto",
    },
    rawArguments: "{}",
  }));
  assert(completed.ok === true);
  const beforeEvidence = commitEvidence(completed);
  assertCommitEvidence(beforeEvidence, markedPath, BRANCH);

  bindingStore.close();
  bindingStore = new SessionBindingStore(bindingStorePath);
  const recovered = await recoverSessionWorkspaceReference({
    sessionId: SESSION_ID,
    bindingStore,
    projectWorkspacePath: sourcePath,
    commandExecutor: createPlatformCommandExecutor(),
  });
  assert(recovered.validation.ok === true);
  assert(recovered.workspaceReference.get() === markedPath);

  const relaunchedExecutor = createExecutor({
    dataPath,
    sourcePath,
    liveReference: recovered.workspaceReference,
  });
  const postRelaunchCommand = asRecord(await relaunchedExecutor({
    name: "run_command",
    args: { command: "printf post-relaunch > smoke-after-relaunch.txt" },
    rawArguments: "{}",
  }));
  assert(postRelaunchCommand.ok === true);
  assert(existsSync(join(markedPath, "smoke-after-relaunch.txt")));
  assert(!existsSync(join(sourcePath, "smoke-after-relaunch.txt")));

  const ledgerRecord = asRecord(await relaunchedExecutor({
    name: "project_ledger_show",
    args: { id: WORK_ID, include_body: true },
    rawArguments: "{}",
  }));
  assert(ledgerRecord.ok === true);
  const afterEvidence = commitEvidence(ledgerRecord);
  assertCommitEvidence(afterEvidence, markedPath, BRANCH);

  return {
    ok: true,
    branch: BRANCH,
    binding: "session_worktree",
    same_turn: {
      file: fileResult.ok === true,
      command: commandResult.ok === true,
      ledger_evidence: Boolean(beforeEvidence),
    },
    recovery: {
      store_reopened: true,
      reference_validated: recovered.validation.ok,
      command: postRelaunchCommand.ok === true,
      ledger_evidence: Boolean(afterEvidence),
    },
    evidence: {
      before_relaunch: Boolean(beforeEvidence),
      after_relaunch: Boolean(afterEvidence),
    },
  };
}

function createExecutor(input: {
  dataPath: string;
  sourcePath: string;
  liveReference: ReturnType<typeof createWorkspaceReference>;
}): ButlerToolExecutor {
  return createButlerToolExecutor({
    butlerHome: REPO_ROOT,
    butlerData: input.dataPath,
    workspacePath: input.sourcePath,
    sessionId: SESSION_ID,
    projectId: PROJECT_ID,
    workspaceReference: input.liveReference,
    sessionBindingStore: bindingStore!,
  });
}

function assert(condition: unknown): asserts condition {
  if (!condition) throw new Error("smoke_assertion_failed");
}
