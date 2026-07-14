import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyContinuityRecovery,
  approveContinuityRecovery,
  planContinuityRecovery,
  rollbackContinuityRecovery,
} from "../../packages/butler-agent/src/agent/cognition/continuity/recovery.ts";
import {
  publishConversationCompletionObservation,
  writeCompletionJobReceipt,
} from "../../packages/butler-agent/src/agent/cognition/continuity/completion-observation.ts";
import { AgentConversationStore } from "../../packages/butler-agent/src/agent/conversation/store.ts";

const roots: string[] = [];
afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true })),
);

test("recovery is dry-run first, provenance scoped, approval gated, idempotent, and exactly rollbackable", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-continuity-recovery-"));
  roots.push(root);
  const data = join(root, "data");
  const projectA = join(root, "project-a");
  const projectB = join(root, "project-b");
  mkdirSync(data, { recursive: true });
  mkdirSync(join(projectA, ".butler"), { recursive: true });
  mkdirSync(join(projectB, ".butler"), { recursive: true });
  seedAppProjectRegistry(data, [
    { id: "project-a", workspacePath: projectA },
    { id: "project-b", workspacePath: projectB },
  ]);
  const projectAHot = join(projectA, ".butler", "hot-cache.md");
  const projectBHot = join(projectB, ".butler", "hot-cache.md");
  const globalHot = join(data, "cognition", "memory", "hot", "cache.md");
  mkdirSync(join(globalHot, ".."), { recursive: true });
  writeFileSync(projectAHot, "ORIGINAL PROJECT A\n");
  writeFileSync(projectBHot, "ORIGINAL PROJECT B\n");
  writeFileSync(globalHot, "MIXED GLOBAL CACHE MUST NOT BE COPIED\n");

  const safeA = seedTurn(data, {
    projectId: "project-a",
    sessionId: "cs-a",
    runtimeSessionId: "butler/a",
    turnId: "turn-a-safe",
    user: "Keep the signed deployment manifest for the next release.",
    assistant: "The signed deployment manifest was validated and retained.",
  });
  const processedA = seedTurn(data, {
    projectId: "project-a",
    sessionId: "cs-a",
    runtimeSessionId: "butler/a",
    turnId: "turn-a-processed",
    user: "This turn already passed through the fixed live pipeline.",
    assistant: "Live completion already wrote this state.",
  });
  seedTurn(data, {
    projectId: "project-a",
    sessionId: "cs-a",
    runtimeSessionId: "butler/a",
    turnId: "turn-a-secret",
    user: "Use token=abcdefghijklmnopqrstuvwxyz123456 for the migration.",
    assistant: "The credential was received.",
  });
  seedTurn(data, {
    projectId: "project-b",
    sessionId: "cs-b",
    runtimeSessionId: "butler/b",
    turnId: "turn-b",
    user: "Project B uses a separate rollout.",
    assistant: "Project B rollout recorded.",
  });
  seedTurn(data, {
    projectId: null,
    sessionId: "cs-global",
    runtimeSessionId: "butler/main",
    turnId: "turn-global",
    user: "This general chat has no authenticated project owner.",
    assistant: "It remains global.",
  });
  const completed = publishConversationCompletionObservation({
    butlerData: data,
    projectId: "project-a",
    runtimeSessionId: "butler/a",
    conversationSessionId: processedA.sessionId,
    conversationTurnId: processedA.turnId,
    inboundMessageId: processedA.userMessageId,
    outboundMessageId: processedA.assistantMessageId,
    outcomeGeneration: 1,
    completedAt: processedA.completedAt,
  });
  writeCompletionJobReceipt(data, {
    schema_version: "butler.memory-completion-job-receipt.v1",
    job_id: completed.job_id,
    completed_at: processedA.completedAt,
    hot_cache_receipt: null,
    index_status: "ok",
  });

  const planned = planContinuityRecovery({
    butlerData: data,
    projectId: "project-a",
    now: "2026-07-14T03:00:00.000Z",
  });
  const rerunPlan = planContinuityRecovery({
    butlerData: data,
    projectId: "project-a",
    now: "2026-07-14T04:00:00.000Z",
  });

  expect(planned.manifest_id).toBe(rerunPlan.manifest_id);
  expect(planned.status).toBe("dry_run");
  expect(planned.inventory_by_project).toMatchObject({
    "project-a": 3,
    "project-b": 1,
    unscoped: 1,
  });
  expect(
    planned.candidates.map((candidate) => candidate.conversation_turn_id),
  ).toEqual([safeA.turnId]);
  expect(planned.quarantine.map((item) => item.reason)).toEqual(
    expect.arrayContaining([
      "missing_project_provenance",
      "secret_or_credential_risk",
    ]),
  );
  expect(readFileSync(projectAHot, "utf8")).toBe("ORIGINAL PROJECT A\n");
  expect(() =>
    applyContinuityRecovery({
      butlerData: data,
      manifestId: planned.manifest_id,
    }),
  ).toThrow("continuity_recovery_approval_required");

  approveContinuityRecovery({
    butlerData: data,
    manifestId: planned.manifest_id,
    candidateIds: "all",
    now: "2026-07-14T03:01:00.000Z",
  });
  const applied = applyContinuityRecovery({
    butlerData: data,
    manifestId: planned.manifest_id,
    now: "2026-07-14T03:02:00.000Z",
  });
  const replay = applyContinuityRecovery({
    butlerData: data,
    manifestId: planned.manifest_id,
  });
  const projectABody = readFileSync(projectAHot, "utf8");
  expect(applied.replayed).toBe(false);
  expect(replay.replayed).toBe(true);
  expect(projectABody).toContain("signed deployment manifest");
  expect(projectABody).not.toContain("fixed live pipeline");
  expect(projectABody).not.toContain("MIXED GLOBAL CACHE");
  expect(readFileSync(projectBHot, "utf8")).toBe("ORIGINAL PROJECT B\n");
  expect(readFileSync(globalHot, "utf8")).toBe(
    "MIXED GLOBAL CACHE MUST NOT BE COPIED\n",
  );
  expect(statSync(projectAHot).size).toBeLessThanOrEqual(20 * 1024);

  const rolledBack = rollbackContinuityRecovery({
    butlerData: data,
    manifestId: planned.manifest_id,
    now: "2026-07-14T03:03:00.000Z",
  });
  const rollbackReplay = rollbackContinuityRecovery({
    butlerData: data,
    manifestId: planned.manifest_id,
  });
  expect(rolledBack.replayed).toBe(false);
  expect(rollbackReplay.replayed).toBe(true);
  expect(readFileSync(projectAHot, "utf8")).toBe("ORIGINAL PROJECT A\n");
});

test("recovery inventories canonical turns beyond one cognition page", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-continuity-recovery-pages-"));
  roots.push(root);
  const data = join(root, "data");
  const project = join(root, "project");
  mkdirSync(join(project, ".butler"), { recursive: true });
  seedAppProjectRegistry(data, [
    { id: "project-pages", workspacePath: project },
  ]);
  const store = new AgentConversationStore({ butlerData: data });
  try {
    for (let index = 0; index < 2_501; index += 1) {
      const turn = store.beginTurn({
        gateway: "app",
        externalSessionId: "butler/pages",
        sessionId: "cs-pages",
        projectId: "project-pages",
        actor: "user",
        turnId: `turn-page-${String(index).padStart(4, "0")}`,
        now: "2026-06-01T00:00:00.000Z",
      });
      store.appendUserMessage({
        sessionId: "cs-pages",
        turnId: turn.id,
        text: `Retain decision ${index}.`,
        now: "2026-06-01T00:00:01.000Z",
      });
      store.appendAssistantMessage({
        sessionId: "cs-pages",
        turnId: turn.id,
        text: `Decision ${index} was retained.`,
        now: "2026-06-01T00:00:02.000Z",
      });
      store.finalizeTurn({
        turnId: turn.id,
        status: "complete",
        completedAt: "2026-06-01T00:00:03.000Z",
      });
    }
  } finally {
    store.close();
  }

  const planned = planContinuityRecovery({
    butlerData: data,
    projectId: "project-pages",
    now: "2026-07-14T05:00:00.000Z",
  });
  expect(planned.inventory_by_project["project-pages"]).toBe(2_501);
  expect(planned.candidates).toHaveLength(2_501);
  expect(
    planned.candidates.some(
      (candidate) => candidate.conversation_turn_id === "turn-page-2500",
    ),
  ).toBe(true);
});

function seedAppProjectRegistry(
  butlerData: string,
  projects: Array<{ id: string; workspacePath: string }>,
): void {
  const appData = join(butlerData, "app-server");
  mkdirSync(appData, { recursive: true });
  const db = new Database(join(appData, "butler-client.sqlite"), {
    create: true,
  });
  try {
    db.run(
      "CREATE TABLE projects (id TEXT PRIMARY KEY, workspace_path TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0)",
    );
    const insert = db.query(
      "INSERT INTO projects (id, workspace_path, archived) VALUES (?, ?, 0)",
    );
    for (const project of projects)
      insert.run(project.id, project.workspacePath);
  } finally {
    db.close();
  }
}

function seedTurn(
  butlerData: string,
  input: {
    projectId: string | null;
    sessionId: string;
    runtimeSessionId: string;
    turnId: string;
    user: string;
    assistant: string;
  },
) {
  const store = new AgentConversationStore({ butlerData });
  const turn = store.beginTurn({
    gateway: "app",
    externalSessionId: input.runtimeSessionId,
    sessionId: input.sessionId,
    projectId: input.projectId,
    actor: "user",
    turnId: input.turnId,
    now: "2026-06-01T00:00:00.000Z",
  });
  const user = store.appendUserMessage({
    sessionId: input.sessionId,
    turnId: turn.id,
    text: input.user,
    now: "2026-06-01T00:00:01.000Z",
  });
  const assistant = store.appendAssistantMessage({
    sessionId: input.sessionId,
    turnId: turn.id,
    text: input.assistant,
    now: "2026-06-01T00:00:02.000Z",
  });
  const completedAt = "2026-06-01T00:00:03.000Z";
  store.finalizeTurn({ turnId: turn.id, status: "complete", completedAt });
  store.close();
  return {
    sessionId: input.sessionId,
    turnId: turn.id,
    userMessageId: user.id,
    assistantMessageId: assistant.id,
    completedAt,
  };
}
