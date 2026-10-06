// Existing durable plan/subsession records; read through the real native gateway.
import { Database } from "bun:sqlite";
import { join } from "node:path";
export type SeedState = "running" | "failed" | "waiting" | "done" | "cancelled";
const start = "2026-10-01T01:00:00Z";
const finish = "2026-10-01T01:00:07Z";
const titles = ["Prepare", "Build", "Check", "Combine", "Publish"];
const dependencies = [[], ["a"], ["a"], ["b", "c"], ["d"]];
const keys = ["a", "b", "c", "d", "e"];

export function seedTaskGraphs(data: string, states: SeedState[], count = 5, parent = "butler/app-general") {
  const db = new Database(join(data, "agent-runtime/btcc.sqlite"));
  const conversations = new Database(join(data, "runtime/conversation-store.sqlite"));
  try {
    db.transaction(() => {
      db.query("INSERT OR IGNORE INTO btcc_inbound_inbox(inbox_id,session_id,trigger_key,turn_id,admission_input_hash,command_json,status) VALUES('graph-parent',?,'graph-parent','graph-parent','fixture','{}','constructed')").run(parent);
      db.query("INSERT OR IGNORE INTO btcc_turns(turn_id,session_id,inbox_id,trigger_key,original_message_id,original_message,admission_snapshot_ref,model_selection_json,context_json,semantic_state,revision,execution_fence) VALUES('graph-parent',?,'graph-parent','graph-parent','message','Fixture','fixture','{}','{}','delivered',1,1)").run(parent);
      states.forEach((state, g) => seedGraph(db, conversations, state, g, count, parent));
    })();
  } finally { db.close(); conversations.close(); }
}

function seedGraph(db: Database, conversations: Database, state: SeedState, g: number, count: number, parent: string) {
  const plan = `graph-${g}`;
  const source = `source-${g}`;
  const actions = Array.from({ length: count }, (_, i) => ({ actionKey: keys[i] ?? `n${i}`,
    description: titles[i] ?? `Task ${i + 1}`, dependencyKeys: count === 16 ? (i ? [keys[i - 1] ?? `n${i - 1}`] : []) : dependencies[i] ?? [] }));
  db.query("INSERT INTO btcc_guided_works(work_id,session_id,scope_kind,scope_ref,origin_turn_id,origin_message_id,objective,status,current_plan_revision_id,created_at,updated_at) VALUES(?,?,'session',?,'graph-parent','message',?,'open',?,?,?)").run(source, parent, parent, `Release ${g + 1}`, plan, start, start);
  db.query("INSERT INTO btcc_guided_work_plan_revisions(plan_revision_id,work_id,revision,objective,governing_refs_json,execution_mode,actions_json,checks_json,origin_turn_id,created_at) VALUES(?,?,1,?,'[]','workers',?,?,'graph-parent',?)").run(plan, source, `Release ${g + 1}`, JSON.stringify(actions), JSON.stringify(["All checks pass"]), start);
  const assigned = state === "waiting" ? 0 : state === "done" || state === "cancelled" ? count : Math.min(3, count);
  for (let i = 0; i < assigned; i++) {
    const terminal = state === "running" && count === 1 ? null : state === "done" || i === 0 ? "success" : state === "cancelled" ? "cancelled" : state === "failed" ? (i === 1 ? "failed" : "success") : null;
    seedWorker(db, conversations, plan, source, g, i, actions[i]!, terminal, parent);
  }
}

function seedWorker(db: Database, conversations: Database, plan: string, source: string, g: number, i: number,
  action: { actionKey: string; description: string; dependencyKeys: string[] }, terminal: string | null, parent: string) {
  const task = `task-${g}-${i}`;
  const child = `worker-${g}-${i}`;
  const relation = `relation-${g}-${i}`;
  const turn = `turn-${g}-${i}`;
  const packet = { child_role: "worker", delegation_id: relation, task_id: task, parent_session_id: parent, parent_turn_id: "graph-parent", relation_id: relation,
    access_mode: "read_only", execution_mode: "read_only", objective: action.description, acceptance_criteria: ["All checks pass"], task_or_plan_refs: [], constraints_and_non_goals: [], allowed_tools_and_effects: [], mutation_scope: [],
    plan_action: { action_key: action.actionKey, description: action.description, dependency_keys: action.dependencyKeys },
    parent_work_ref: { work_id: source, session_id: parent, turn_id: "graph-parent", plan_revision_id: plan, review_revision_id: "review" }, model_ref: "openai/gpt-6-luna", reasoning_effort: "max" };
  db.query("INSERT INTO btcc_session_relations(relation_id,parent_session_id,parent_turn_id,child_session_id,anchor_message_id,ordinal,safe_title,created_at) VALUES(?,?,'graph-parent',?,'anchor',?,?,?)").run(relation, parent, child, g * 20 + i + 1, action.description, start);
  db.query("INSERT INTO btcc_subsession_delegations(delegation_id,relation_id,task_id,child_turn_id,root_work_id,packet_json,created_at) VALUES(?,?,?,?,?,?,?)").run(relation, relation, task, turn, `root-${task}`, JSON.stringify(packet), start);
  db.query("INSERT INTO btcc_inbound_inbox(inbox_id,session_id,trigger_key,turn_id,admission_input_hash,command_json,status) VALUES(?,?,?,?,'fixture','{}','constructed')").run(turn, child, turn, turn);
  const semantic = terminal === "cancelled" ? "cancelled" : terminal ? "delivered" : "admitted";
  db.query("INSERT INTO btcc_turns(turn_id,session_id,inbox_id,trigger_key,original_message_id,original_message,admission_snapshot_ref,model_selection_json,context_json,semantic_state,revision,execution_fence) VALUES(?,?,?,?,?,'Fixture','fixture','{}','{}',?,1,1)").run(turn, child, turn, turn, turn, semantic);
  if (terminal) db.query("INSERT INTO btcc_steward_results(result_id,relation_id,task_id,child_session_id,child_turn_id,status,summary,acceptance_evidence_json,changed_artifacts_json,created_at) VALUES(?,?,?,?,?,?,'Checks complete','[]','[]',?)").run(relation, relation, task, child, turn, terminal, finish);
  conversations.query("INSERT INTO conversation_sessions(id,gateway_origin,created_at,updated_at,status,schema_version) VALUES(?,'app',?,?,'active',5)").run(child, start, finish);
  conversations.query("INSERT INTO conversation_turns(id,session_id,seq,actor,status,started_at,completed_at) VALUES(?,?,1,'assistant',?,?,?)")
    .run(turn, child, terminal ? "complete" : "running", terminal ? start : new Date(Date.now() - 3000).toISOString(), terminal ? finish : null);
}

export function finishGraphWorkers(data: string) {
  const db = new Database(join(data, "agent-runtime/btcc.sqlite"));
  const conversations = new Database(join(data, "runtime/conversation-store.sqlite"));
  try {
    const now = new Date().toISOString();
    db.query("INSERT OR IGNORE INTO btcc_steward_results(result_id,relation_id,task_id,child_session_id,child_turn_id,status,summary,acceptance_evidence_json,changed_artifacts_json,created_at) SELECT d.delegation_id,d.relation_id,d.task_id,r.child_session_id,d.child_turn_id,'success','Checks complete','[]','[]',? FROM btcc_subsession_delegations d JOIN btcc_session_relations r ON r.relation_id=d.relation_id").run(now);
    db.run("UPDATE btcc_turns SET semantic_state='delivered',revision=revision+1 WHERE session_id LIKE 'worker-%'");
    conversations.query("UPDATE conversation_turns SET status='complete',completed_at=? WHERE status='running'").run(now);
  } finally { db.close(); conversations.close(); }
}
