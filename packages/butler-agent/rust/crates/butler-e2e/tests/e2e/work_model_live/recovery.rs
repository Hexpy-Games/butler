//! A real restart reconciles the retained Task, part and following step.
use super::*;
use serde_json::json;

#[tokio::test]
async fn managed_attempts_recover_after_clean_and_crash_shutdown() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    for clean in [true, false] {
        let (url, _, server) = stub::start().await?;
        let mut s = Setup::new("WMU-RECOVERY")?
            .access(Access::FullAccess)
            .stub_cassette(Cassette::load("TOOL-01")?)
            .env("BUTLER_CODEX_BASE_URL", url)
            .start()
            .await?;
        s.turn("general", JOB).await?;
        database(&s, |db| {
            db.execute_batch(
                "BEGIN IMMEDIATE;
             UPDATE wm_tasks SET status=CASE step_index WHEN 0 THEN 'running' ELSE 'waiting' END,
                 result_reported_at=NULL,completion_revision=NULL;
             UPDATE wm_task_chains SET state='active';
             UPDATE wm_works SET run_state='running';
             UPDATE wm_counts SET count=0 WHERE key LIKE 'run_state:%';
             INSERT INTO wm_counts(scope_kind,scope_ref,key,count)
                 SELECT scope_kind,scope_ref,'run_state:'||run_state,count(*)
                 FROM wm_works GROUP BY scope_kind,scope_ref,run_state
                 ON CONFLICT(scope_kind,scope_ref,key) DO UPDATE SET count=excluded.count;
             INSERT INTO wm_task_parts(id,task_id,kind,title,status,part_rank)
                 SELECT 'retained-part',id,'execute','Retained execution','running','A'
                 FROM wm_tasks WHERE step_index=0;
             INSERT INTO wm_attempts(id,task_id,part_id,task_revision,spec_ref,session_id,
                 turn_id,lease_epoch,status,started_at)
             SELECT 'restart-task',id,NULL,revision,spec_ref,assignee_session_id,
                 'retained-turn',1,'running',1 FROM wm_tasks WHERE step_index=0;
             INSERT INTO wm_attempts(id,task_id,part_id,task_revision,spec_ref,session_id,
                 turn_id,lease_epoch,status,started_at)
             SELECT 'restart-part',t.id,p.id,t.revision,t.spec_ref,t.assignee_session_id,
                 'retained-turn',1,'running',1 FROM wm_task_parts p
                 JOIN wm_tasks t ON t.id=p.task_id WHERE p.kind='execute';
             COMMIT;",
            )
        })
        .await?;
        if clean {
            s.agent.terminate().await?;
        } else {
            s.agent.kill9()?;
        }
        s.gw = s.agent.start_again().await?;
        let state = snapshot(&s).await?;
        assert_eq!(
            state["tasks"][0]["status"],
            if clean { "pending" } else { "failed" }
        );
        assert_eq!(state["tasks"][0]["step"], 0);
        assert_eq!(
            state["tasks"][1]["status"],
            if clean { "waiting" } else { "held" }
        );
        assert_eq!(state["tasks"][1]["step"], 1);
        assert_eq!(state["part"], if clean { "pending" } else { "failed" });
        assert_eq!(state["attempts"], 2);
        assert_eq!(state["holds"], i64::from(!clean));
        s.agent.terminate().await?;
        s.gw = s.agent.start_again().await?;
        assert_eq!(snapshot(&s).await?, state, "recovery runs once");
        server.abort();
        s.finish().await?;
    }
    Ok(())
}

async fn snapshot(
    s: &butler_e2e::e2e::scenario::Scenario,
) -> Result<serde_json::Value, HarnessError> {
    database(s, |db| {
        let tasks = db.prepare("SELECT status,step_index FROM wm_tasks ORDER BY step_index")?
            .query_map([], |r| Ok(json!({"status":r.get::<_,String>(0)?,"step":r.get::<_,i64>(1)?})))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let part: String = db.query_row("SELECT status FROM wm_task_parts WHERE kind='execute'", [], |r| r.get(0))?;
        let attempts: i64 = db.query_row("SELECT count(*) FROM wm_attempts WHERE id IN ('restart-task','restart-part') AND status='interrupted' AND recovered_at IS NOT NULL", [], |r| r.get(0))?;
        let holds: i64 = db.query_row("SELECT count(*) FROM wm_task_hold_decisions WHERE decision IS NULL AND resolved_at IS NULL", [], |r| r.get(0))?;
        Ok(json!({"tasks":tasks,"part":part,"attempts":attempts,"holds":holds}))
    }).await
}
