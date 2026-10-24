//! Canon runtime reads. Kept public so the integrated schema can pin every plan.
macro_rules! queries {
    ($($name:ident => $sql:literal),+ $(,)?) => {
        #[derive(Clone, Copy, Debug)]
        pub enum Query { $($name),+ }
        impl Query {
            pub const fn all() -> &'static [Self] { &[$(Self::$name),+] }
            pub const fn sql(self) -> &'static str { match self { $(Self::$name => $sql),+ } }
        }
    };
}
queries! {
    InsertLink => "INSERT INTO canon_epic_work_links(epic_id,btcc_work_id,session_id,linked_at,linked_by) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(btcc_work_id) DO NOTHING",
    AdvanceLabel => "UPDATE canon_epics SET canon_status=?2,canon_status_source='runtime',revision=revision+1,updated_at=?3 WHERE id=?1",
    AdvanceCursor => "INSERT INTO canon_cursors(name,value) VALUES(?1,?2) ON CONFLICT(name) DO UPDATE SET value=excluded.value",
    Link => "SELECT epic_id FROM canon_epic_work_links WHERE btcc_work_id=?1",
    Bound => "SELECT 1 FROM canon_session_epics WHERE session_id=?1 AND epic_id=?2",
    Cursor => "SELECT value FROM canon_cursors WHERE name=?1",
    Plans => "SELECT p.rowid,p.work_id,w.session_id,p.governing_refs_json FROM btcc_guided_work_plan_revisions p JOIN btcc_guided_works w ON w.work_id=p.work_id WHERE p.rowid>?1 ORDER BY p.rowid LIMIT 256",
    Feed => "SELECT seq,session_id FROM agent_task_graph_changes WHERE seq>?1 ORDER BY seq LIMIT 256",
    SessionEpics => "SELECT epic_id FROM canon_session_epics WHERE session_id=?1 UNION SELECT epic_id FROM canon_epic_work_links WHERE session_id=?1",
    Works => "SELECT w.*,l.linked_at FROM canon_epic_work_links l JOIN btcc_guided_works w ON w.work_id=l.btcc_work_id WHERE l.epic_id=?1 ORDER BY l.linked_at,l.btcc_work_id",
    Plan => "SELECT * FROM btcc_guided_work_plan_revisions WHERE work_id=?1 ORDER BY revision DESC LIMIT 1",
    Checkpoints => "SELECT * FROM btcc_guided_work_checkpoint_revisions WHERE work_id=?1 ORDER BY revision",
    PlanCheckpoint => "SELECT * FROM btcc_guided_work_checkpoint_revisions WHERE work_id=?1 AND plan_revision_id=?2 ORDER BY revision DESC LIMIT 1",
    Disposition => "SELECT * FROM btcc_guided_work_disposition_revisions WHERE work_id=?1 ORDER BY revision DESC LIMIT 1",
    Review => "SELECT * FROM btcc_guided_work_review_revisions WHERE work_id=?1 ORDER BY revision DESC LIMIT 1",
    Turn => "SELECT semantic_state FROM btcc_turns WHERE turn_id=?1",
    OwnActive => "SELECT 1 FROM btcc_turns INDEXED BY idx_btcc_turns_active WHERE session_id=?1 AND semantic_state IN ('admitted','delivery_committed') LIMIT 1",
    DelegatedActive => "SELECT 1 FROM btcc_subsession_delegations d INDEXED BY idx_btcc_graph_work JOIN btcc_turns t ON t.turn_id=d.child_turn_id WHERE json_extract(d.packet_json,'$.parent_work_ref.work_id')=?1 AND json_extract(d.packet_json,'$.child_role')='steward' AND t.semantic_state IN ('admitted','delivery_committed') LIMIT 1",
}
