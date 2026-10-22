CREATE INDEX IF NOT EXISTS wm_works_scope ON wm_works(scope_kind,scope_ref,visibility,run_state);
CREATE INDEX IF NOT EXISTS wm_works_plan ON wm_works(plan_id,plan_rank) WHERE visibility='canon';
CREATE INDEX IF NOT EXISTS wm_works_backlog ON wm_works(scope_ref,plan_rank) WHERE visibility='canon' AND plan_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS wm_works_home ON wm_works(home_session_id) WHERE visibility='canon' AND home_session_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS wm_task_hold_decisions_pending ON wm_task_hold_decisions(chain_id,held_step_index) WHERE decision IS NULL AND resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS wm_plans_project ON wm_plans(project_id,status,due_on);
CREATE INDEX IF NOT EXISTS wm_tasks_progress ON wm_tasks(work_id,status);
CREATE INDEX IF NOT EXISTS wm_task_edges_successor ON wm_task_edges(work_id,succ,pred);
CREATE INDEX IF NOT EXISTS wm_task_criteria_consumers ON wm_task_criteria(node_id,node_revision,criterion_id);
CREATE INDEX IF NOT EXISTS wm_spec_nodes_work ON wm_spec_nodes(work_id);
CREATE INDEX IF NOT EXISTS wm_spec_nodes_parent ON wm_spec_nodes(parent_node_id);
CREATE INDEX IF NOT EXISTS wm_instructions_pending ON wm_instructions(target_session_id,status,received_seq)
 WHERE status IN ('accepted','waiting_for_turn','waiting_for_task','pending_safe_point');
CREATE UNIQUE INDEX IF NOT EXISTS wm_attempts_lease ON wm_attempts(task_id) WHERE status='running' AND part_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS wm_attempts_part_lease ON wm_attempts(part_id) WHERE status='running' AND part_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS wm_attempts_task ON wm_attempts(task_id,started_at,id);
CREATE INDEX IF NOT EXISTS wm_results_task ON wm_results(task_id,revision DESC);
CREATE INDEX IF NOT EXISTS wm_attempts_running ON wm_attempts(session_id) WHERE status='running';
CREATE INDEX IF NOT EXISTS wm_outbox_unpublished ON wm_outbox(published,seq) WHERE published=0;
CREATE INDEX IF NOT EXISTS wm_cross_db_intents_pending ON wm_cross_db_intents(state,op_id) WHERE state='pending';
CREATE INDEX IF NOT EXISTS wm_task_hold_decisions_resolved ON wm_task_hold_decisions(chain_id,decision) WHERE decision='run_anyway' AND resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS wm_attempts_interrupted ON wm_attempts(session_id) WHERE status='interrupted';
CREATE INDEX IF NOT EXISTS wm_task_chains_queue ON wm_task_chains(work_id,state,created_at);
CREATE INDEX IF NOT EXISTS wm_tasks_chain ON wm_tasks(chain_id,step_index,stack_position);
CREATE INDEX IF NOT EXISTS wm_task_edges_chain ON wm_task_edges(chain_id,pred,succ);
CREATE INDEX IF NOT EXISTS wm_task_parts_order ON wm_task_parts(task_id,part_rank);
CREATE INDEX IF NOT EXISTS wm_task_part_edges_successor ON wm_task_part_edges(task_id,succ);

CREATE INDEX IF NOT EXISTS wm_works_local_home ON wm_works(home_session_id,updated_at DESC,id) WHERE home_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS wm_task_parts_session ON wm_task_parts(assignee_session_id,part_rank,id) WHERE assignee_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS wm_tasks_session ON wm_tasks(assignee_session_id,work_id) WHERE assignee_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS wm_reviews_task ON wm_reviews(task_id,at,id);
CREATE INDEX IF NOT EXISTS wm_audit_entity ON wm_audit(entity_kind,entity_id,seq);

CREATE INDEX IF NOT EXISTS wm_holds_active ON wm_holds(target,kind,id) WHERE released_at IS NULL;

CREATE INDEX IF NOT EXISTS wm_intents_pending_kind ON wm_cross_db_intents(kind,op_id) WHERE state='pending';
CREATE INDEX IF NOT EXISTS wm_instructions_turn ON wm_instructions(target_session_id,anchor_kind,anchor_id);
