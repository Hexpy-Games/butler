//! Queue SQL. Startup enumeration is separate from the indexed request reads.
pub const REVISION: &str =
    "SELECT graph_revision FROM canon_session_queue_heads WHERE session_id=?1";
pub const ADVANCE_REVISION: &str = "INSERT INTO canon_session_queue_heads(session_id,graph_revision) VALUES(?1,1) ON CONFLICT(session_id) DO UPDATE SET graph_revision=graph_revision+1";
pub const ITEMS: &str = "SELECT q.*,e.title,e.canon_status,c.plan_id FROM canon_session_queue q JOIN canon_epics e ON e.id=q.epic_id LEFT JOIN canon_session_queue_chains c ON c.session_id=q.session_id AND c.chain_id=q.chain_id WHERE q.session_id=?1 AND q.state<>'removed' ORDER BY q.chain_id,q.step_index,q.stack_position";
pub const PLACE: &str = "UPDATE canon_session_queue SET chain_id=?3,step_index=?4,stack_position=?5 WHERE session_id=?1 AND epic_id=?2";
pub const INSERT_CHAIN: &str = "INSERT INTO canon_session_queue_chains(session_id,chain_id,plan_id) SELECT ?1,?2,plan_id FROM canon_epics WHERE id=?3 ON CONFLICT(session_id,chain_id) DO NOTHING";
pub const RUNNING: &str = "SELECT step_op_id FROM canon_session_queue WHERE state='running' AND step_op_id IS NOT NULL AND (hold_reason IS NULL OR turn_ended_at IS NULL)";
pub const INSERT: &str = "INSERT INTO canon_session_queue(session_id,epic_id,chain_id,step_index,stack_position,state,origin,origin_message_id) VALUES(?1,?2,?3,?4,0,'waiting',?5,?6) ON CONFLICT(session_id,epic_id) DO UPDATE SET chain_id=excluded.chain_id,step_index=excluded.step_index,stack_position=0,state='waiting',origin=excluded.origin,origin_message_id=excluded.origin_message_id,hold_reason=NULL,held_by_epic_id=NULL,decision=NULL,decided_at=NULL,question_message_id=NULL,step_op_id=NULL,started_at=NULL,btcc_work_id=NULL,result_reported_at=NULL,turn_ended_at=NULL,step_turn_id=NULL";
pub const ELSEWHERE: &str = "SELECT q.*,e.title FROM canon_session_queue q JOIN canon_epics e ON e.id=q.epic_id WHERE q.epic_id=?1 AND q.state IN ('waiting','running','held') AND q.session_id<>?2";
pub const PENDING: &str = "SELECT rowid AS replay_cursor,* FROM canon_intents WHERE state='pending' AND kind IN ('canon_step','canon_hold','canon_take_here') AND rowid>?1 ORDER BY rowid LIMIT 128";
pub const REMOVE: &str =
    "UPDATE canon_session_queue SET state='removed' WHERE session_id=?1 AND epic_id=?2";
pub const DETACH: &str = "UPDATE canon_session_queue SET chain_id=?3,step_index=0,stack_position=0,origin='detach',state='waiting',hold_reason=NULL,held_by_epic_id=NULL,decision=NULL,decided_at=NULL,question_message_id=NULL,step_op_id=NULL,started_at=NULL,btcc_work_id=NULL,result_reported_at=NULL,turn_ended_at=NULL,step_turn_id=NULL WHERE session_id=?1 AND epic_id=?2";
pub const HOLD_SUCCESSORS: &str = "UPDATE canon_session_queue SET state='held',hold_reason='predecessor_failed',held_by_epic_id=?3 WHERE session_id=?1 AND chain_id=?2 AND step_index>?4 AND state='waiting'";
pub const START: &str = "UPDATE canon_session_queue SET state='running',started_at=?3,step_op_id=?4,turn_ended_at=NULL,step_turn_id=NULL WHERE session_id=?1 AND epic_id=?2 AND state='waiting'";
pub const OWNER: &str =
    "SELECT * FROM canon_session_queue WHERE epic_id=?1 AND state IN ('waiting','running','held')";
pub const DONE: &str = "UPDATE canon_session_queue SET state='done',btcc_work_id=?3,result_reported_at=?4 WHERE session_id=?1 AND epic_id=?2";
pub const RESOLVE: &str = "UPDATE canon_session_queue SET state='done',hold_reason=NULL,btcc_work_id=?3,result_reported_at=?4 WHERE session_id=?1 AND epic_id=?2";
pub const STEP: &str = "SELECT * FROM canon_session_queue WHERE step_op_id=?1";
pub const FAIL: &str = "UPDATE canon_session_queue SET hold_reason=?3,question_message_id=?4 WHERE session_id=?1 AND epic_id=?2 AND decision IS NULL";
pub const PLAN_EPICS: &str = "SELECT id FROM canon_epics WHERE plan_id=?1 AND canon_status NOT IN ('done','cancelled') ORDER BY plan_rank,id";
pub const DELETE_ITEM: &str = "DELETE FROM canon_session_queue WHERE session_id=?1 AND epic_id=?2";
pub const ITEM: &str = "SELECT * FROM canon_session_queue WHERE session_id=?1 AND epic_id=?2";
pub const DECIDE: &str = "UPDATE canon_session_queue SET state=?3,decision=?4,decided_at=?5 WHERE session_id=?1 AND epic_id=?2";
pub const UNHOLD: &str = "UPDATE canon_session_queue SET state='waiting',hold_reason=NULL,held_by_epic_id=NULL WHERE session_id=?1 AND state='held' AND held_by_epic_id=?2";
pub const BOUND_SESSIONS: &str = "SELECT DISTINCT session_id FROM canon_session_epics UNION SELECT DISTINCT session_id FROM canon_session_queue INDEXED BY canon_queue_active_epic WHERE state IN ('waiting','running','held') UNION SELECT json_extract(payload_json,'$.session_id') FROM canon_intents WHERE state='pending' AND kind IN ('canon_step','canon_hold','canon_take_here') UNION SELECT json_extract(payload_json,'$.other_session_id') FROM canon_intents WHERE state='pending' AND kind IN ('canon_step','canon_hold','canon_take_here') AND json_extract(payload_json,'$.other_session_id') IS NOT NULL UNION SELECT source_session_id FROM canon_step_cancellations";
pub const DELETE_QUEUE: &str = "DELETE FROM canon_session_queue WHERE session_id=?1";
pub const DELETE_BINDINGS: &str = "DELETE FROM canon_session_epics WHERE session_id=?1";
pub const CANCEL_INTENTS: &str = "UPDATE canon_intents SET state='applied',revision=revision+1 WHERE json_extract(payload_json,'$.session_id')=?1 AND kind IN ('canon_step','canon_hold','canon_take_here') AND state='pending'";
pub const CANCEL_OTHER_INTENTS: &str = "UPDATE canon_intents SET state='applied',revision=revision+1 WHERE json_extract(payload_json,'$.other_session_id')=?1 AND kind IN ('canon_step','canon_hold','canon_take_here') AND state='pending'";
pub const SOURCE_CANCELLATIONS: &str =
    "SELECT op_id FROM canon_step_cancellations WHERE source_session_id=?1";
pub const DELETE_HEAD: &str = "DELETE FROM canon_session_queue_heads WHERE session_id=?1";
pub const OFFERS: &str = "SELECT op_id,payload_json FROM canon_intents WHERE kind='canon_take_here' AND json_extract(payload_json,'$.state')='pending' AND json_extract(payload_json,'$.session_id')=?1 AND json_extract(payload_json,'$.epic_id')=?2";
pub const LINKED_WORK: &str = "SELECT w.*,l.linked_at FROM canon_epic_work_links l JOIN btcc_guided_works w ON w.work_id=l.btcc_work_id WHERE l.epic_id=?1 AND l.session_id=?2 AND l.linked_at>=?3 ORDER BY l.linked_at DESC,l.btcc_work_id DESC LIMIT 1";

/// Each request/runtime read is checked against the integrated schema in E2E.
pub const READS: &[&str] = &[
    CANCEL_INTENTS,
    CANCEL_OTHER_INTENTS,
    SOURCE_CANCELLATIONS,
    REVISION,
    RUNNING,
    ITEMS,
    ELSEWHERE,
    PENDING,
    OWNER,
    STEP,
    PLAN_EPICS,
    ITEM,
    OFFERS,
    LINKED_WORK,
];

/// Pin the lookup keys, not just SEARCH: a state-only search visits every pending intent.
pub const INTENT_LOOKUPS: &[(&str, &str)] = &[
    (
        CANCEL_INTENTS,
        "SEARCH canon_intents USING INDEX canon_intents_pending_session (state=? AND <expr>=? AND kind=?)",
    ),
    (
        CANCEL_OTHER_INTENTS,
        "SEARCH canon_intents USING INDEX canon_intents_pending_other_session (state=? AND <expr>=? AND kind=?)",
    ),
    (
        OFFERS,
        "SEARCH canon_intents USING INDEX canon_intents_take (<expr>=? AND <expr>=?)",
    ),
];
