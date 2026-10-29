CREATE INDEX IF NOT EXISTS canon_epics_project ON canon_epics(project_id);
CREATE INDEX IF NOT EXISTS canon_epics_plan ON canon_epics(plan_id,plan_rank);
CREATE INDEX IF NOT EXISTS canon_epics_backlog ON canon_epics(project_id,plan_rank) WHERE plan_id IS NULL;
CREATE INDEX IF NOT EXISTS canon_plans_project ON canon_plans(project_id,status,due_on);
CREATE INDEX IF NOT EXISTS canon_spec_nodes_epic ON canon_spec_nodes(epic_id);
CREATE INDEX IF NOT EXISTS canon_spec_nodes_parent ON canon_spec_nodes(parent_node_id);
CREATE INDEX IF NOT EXISTS canon_events_unpublished ON canon_events(published,seq) WHERE published=0;
CREATE INDEX IF NOT EXISTS canon_intents_pending ON canon_intents(state,op_id) WHERE state='pending';
CREATE INDEX IF NOT EXISTS canon_spec_nodes_epic_parent ON canon_spec_nodes(epic_id,parent_node_id);
