import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BTCC_SUCCESSOR_SCHEMA } from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/schema.ts";
import { BTCC_SUBSESSION_SCHEMA } from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/schema/subsession-schema.ts";
import { migrateSubsessionResultSchema } from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/schema/subsession-schema-migration.ts";
import { SqliteSubsessionDelegationStore } from "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/subsession-store.ts";
import { createSubsessionControlService } from "../../packages/butler-agent/src/agent/btcc/subsessions/control.ts";
import { completeStewardResultForDependencies } from "../../packages/butler-agent/src/agent/btcc/subsessions/terminal-result-service.ts";
import { activeParentDelegations } from "../../packages/butler-agent/src/agent/btcc/subsessions/active-parent-delegation.ts";
import { resolveParentResultEvidence } from "../../packages/butler-agent/src/agent/btcc/subsessions/accepted-terminal-report.ts";
import { subsessionResultId } from "../../packages/butler-agent/src/agent/btcc/subsessions/identities.ts";
import { createSubsessionToolHandlers } from "../../packages/butler-agent/src/agent/tools/subsession/executor.ts";
import { NativeInboundQueue } from "../../packages/butler-agent/src/gateways/core/inbound-queue.ts";
import type { SubsessionDelegationDependencies, SubsessionDelegationService } from "../../packages/butler-agent/src/agent/btcc/subsessions/contracts.ts";

test("reported open Work follows the public steering tool into its original owner and appends an exact report", async () => {
  const f = fixture();
  try {
    const initial = await f.report("child-initial", "blocked", "Awaiting user acceptance.");
    expect(await activeParentDelegations(f.dependencies, { parentSessionId: "parent" })).toHaveLength(0);
    const handlers = createSubsessionToolHandlers({ service: f.controls as unknown as SubsessionDelegationService,
      parentSessionId: "other-chat", parentTurnId: "user-turn", anchorMessageId: "user-message" });
    const call = { name: "steer_steward", args: { work_id: "existing-work", instruction: "User verified the feature; review and close only this Work." } };
    const direction = await handlers.steer_steward!(call as any) as any;
    expect(direction.relation_id).toBe("relation-abcd");
    expect(direction.status).toBe("pending");
    const queueFiles = readdirSync(join(f.root, "runtime/inbound-events/pending"));
    expect(queueFiles).toHaveLength(1);
    const queuedText = readFileSync(join(f.root, "runtime/inbound-events/pending", queueFiles[0]!), "utf8");
    expect(JSON.parse(queuedText).envelope.routingHints.sessionId).toBe("child");
    expect(queuedText).toContain("retained checkpoint");
    expect(f.bindings).toHaveLength(0);
    const followupTurn = JSON.parse(queuedText).envelope.routingHints.turnId;
    expect(await activeParentDelegations(f.dependencies, { parentSessionId: "parent" })).toHaveLength(1);
    await f.controls.consumeStewardDirection({ childSessionId: "child", childTurnId: followupTurn });
    const final = await f.report(followupTurn, "success", "User acceptance recorded; original Work completed.");
    expect(final.status).toBe("committed");
    expect(f.store.resultByRelationId("relation-abcd")?.direction_revision).toBe(1);
    expect(f.store.resultByRelationId("relation-abcd", initial.result.result_id)?.status).toBe("blocked");
    expect(f.db.query("SELECT result_id FROM btcc_steward_results").all()).toHaveLength(2);
    expect(f.db.query("SELECT result_id FROM btcc_subsession_outbox").all()).toHaveLength(2);
    expect(f.deliveries).toHaveLength(2);
    expect(await activeParentDelegations(f.dependencies, { parentSessionId: "parent" })).toHaveLength(0);
    const originalEvidence = await resolveParentResultEvidence({ parentSessionId: "parent", parentInputText: f.deliveries[0]!.text,
      store: f.store, turns: f.dependencies.parentTurns });
    expect(originalEvidence?.outcome).toBe("blocked");
    expect((await f.report(followupTurn, "success", "duplicate")).status).toBe("duplicate");
    expect(f.deliveries).toHaveLength(2);
    await expect(f.report("unaddressed-turn", "success", "Not an authorized followup")).rejects.toThrow("subsession_followup_direction_required");
  } finally { f.close(); }
});

test("followup rejects another project, read-only source and already completed Work before queueing", async () => {
  const f = fixture();
  try {
    await f.report("child-initial", "blocked", "Waiting.");
    const input = { parentSessionId: "other-chat", sourceParentTurnId: "user-turn", sourceMessageId: "user-message",
      workId: "existing-work", instruction: "Accept." };
    f.source.ledgerProjectId = "unrelated";
    await expect(f.controls.steerSteward(input)).rejects.toThrow("steward_followup_project_mismatch");
    f.source.ledgerProjectId = "ledger-project";
    f.sourceTurn.modelSelection.controls.accessMode = "read_only";
    await expect(f.controls.steerSteward(input)).rejects.toThrow("steward_followup_authority_mismatch");
    f.sourceTurn.modelSelection.controls.accessMode = "full_access";
    f.work.status = "completed";
    await expect(f.controls.steerSteward(input)).rejects.toThrow("steward_followup_open_work_required");
    expect(f.db.query("SELECT * FROM btcc_subsession_directions").all()).toHaveLength(0);
    expect(f.bindings).toHaveLength(0);
  } finally { f.close(); }
});

test("legacy relation-unique results and outbox migrate without losing rows or replay identity", () => {
  const db = new Database(":memory:");
  try {
    const legacy = BTCC_SUBSESSION_SCHEMA.replace("direction_revision INTEGER NOT NULL DEFAULT 0,", "")
      .replaceAll("relation_id TEXT NOT NULL,", "relation_id TEXT NOT NULL UNIQUE,");
    db.exec(legacy);
    db.exec("INSERT INTO btcc_steward_results (result_id,relation_id,task_id,child_session_id,child_turn_id,status,summary,acceptance_evidence_json,changed_artifacts_json,created_at) VALUES ('old','r','t','c','turn','blocked','retained','[]','[]','now')");
    db.exec("INSERT INTO btcc_subsession_outbox VALUES ('o','r','old','p','pt','m','{}','pending','now',NULL)");
    migrateSubsessionResultSchema(db);
    migrateSubsessionResultSchema(db);
    expect(db.query("SELECT summary,direction_revision FROM btcc_steward_results").get()).toEqual({ summary: "retained", direction_revision: 0 });
    expect(db.query("SELECT result_id,status FROM btcc_subsession_outbox").get()).toEqual({ result_id: "old", status: "pending" });
    const definitions = db.query<{ sql: string }, []>("SELECT sql FROM sqlite_schema WHERE name IN ('btcc_steward_results','btcc_subsession_outbox')").all();
    expect(definitions.every((row) => !row.sql.includes("relation_id TEXT NOT NULL UNIQUE"))).toBe(true);
  } finally { db.close(); }
});

test("restart recovers a persisted direction before queue dispatch without binding an unadmitted Turn", async () => {
  const f = fixture();
  try {
    await f.report("child-initial", "blocked", "Waiting.");
    f.store.createDirection({ instruction_id: "direction-before-crash", relation_id: "relation-abcd",
      source_parent_turn_id: "user-turn", source_message_id: "user-message", instruction: "Accept existing work.",
      created_at: new Date().toISOString() });
    f.store.createDirection({ instruction_id: "second-direction-before-admission", relation_id: "relation-abcd",
      source_parent_turn_id: "second-user-turn", source_message_id: "second-user-message", instruction: "Preserve the completed actions.",
      created_at: new Date().toISOString() });
    await f.controls.recoverPendingDirections();
    await f.controls.recoverPendingDirections();
    expect(readdirSync(join(f.root, "runtime/inbound-events/pending"))).toHaveLength(1);
    expect(f.bindings).toHaveLength(0);
  } finally { f.close(); }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "steward-followup-"));
  const db = new Database(":memory:");
  db.exec(BTCC_SUCCESSOR_SCHEMA);
  db.exec("INSERT INTO btcc_session_relations VALUES ('relation-abcd','parent','parent-turn','child','anchor',1,'Existing work','now')");
  const packet = { relation_id: "relation-abcd", parent_session_id: "parent", parent_turn_id: "parent-turn", task_id: "task",
    parent_work_ref: { session_id: "parent", turn_id: "parent-turn", work_id: "parent-work" },
    access_and_budget_policy: { access_mode: "full_access" }, model_ref: "openai/test", reasoning_effort: "low" };
  db.query("INSERT INTO btcc_subsession_delegations (delegation_id,relation_id,task_id,child_turn_id,root_work_id,packet_json,created_at) VALUES ('delegation','relation-abcd','task','child-initial','existing-work',?,'now')").run(JSON.stringify(packet));
  const store = new SqliteSubsessionDelegationStore(db);
  const source = { sessionId: "other-chat", role: "butler", appProjectId: "app-project", ledgerProjectId: "ledger-project" };
  const child = { sessionId: "child", role: "steward", projectId: "app-project", appProjectId: "app-project", ledgerProjectId: "ledger-project",
    workspacePath: root, modelRef: "openai/test", metadata: { reasoning_effort: "low" } };
  const sourceTurn = { turnId: "user-turn", sessionId: "other-chat", originalMessageId: "user-message",
    modelSelection: { controls: { accessMode: "full_access" } }, context: {} };
  const work = { workId: "existing-work", sessionId: "child", status: "blocked" };
  const bindings: Array<{ sessionId: string; turnId: string; workId: string }> = [];
  const deliveries: Array<{ text: string }> = [];
  const dependencies = { butlerData: root, store,
    sessionBindings: { getBySessionId: (id: string) => id === "child" ? child : id === "other-chat" ? source
      : { sessionId: "parent", role: "butler", modelRef: "openai/test", metadata: { reasoning_effort: "low" }, transportBindings: [{ transport: "app", peerId: "original-chat" }] } },
    parentTurns: { findTurn: async (id: string) => id === "user-turn" ? sourceTurn : ({ turnId: id, sessionId: "child", semanticState: "delivered" }),
      findLatestTurnForSession: async () => ({ turnId: "child-initial", sessionId: "child", semanticState: "delivered" }) },
    durableWork: { boundWorkForTurn: async () => work,
      bindOpenWork: async (scope: { sessionId: string; turnId: string }, workId: string) => { bindings.push({ ...scope, workId }); return work; } },
  } as unknown as SubsessionDelegationDependencies;
  const controls = createSubsessionControlService(dependencies, new NativeInboundQueue(root));
  return { root, db, store, source, sourceTurn, work, bindings, deliveries, dependencies, controls,
    report: (childTurnId: string, status: "blocked" | "success", summary: string) => completeStewardResultForDependencies(dependencies,
      async (input) => { deliveries.push(input); }, { childSessionId: "child", childTurnId, resultId: subsessionResultId("child", childTurnId), status, summary }),
    close: () => { db.close(); rmSync(root, { recursive: true, force: true }); },
  };
}
