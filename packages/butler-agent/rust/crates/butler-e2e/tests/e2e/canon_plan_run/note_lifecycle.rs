//! Completed runs disappear; rolling context preserves the current run status.
use super::run_note::{edit, note_refs, requests, run_plan};
use super::*;
use std::sync::atomic::Ordering;

#[tokio::test]
async fn finished_runs_leave_the_note_while_another_run_remains() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, first, chat) =
        crate::canon_link::setup("CB-NOTE-FINISHED", false, false).await?;
    let (plan_id, epics) = plan(&s, &script, &first).await?;
    script.blocked.lock().unwrap().push(epics[1].clone());
    script.release();
    run_plan(&s, &chat, &plan_id).await?;
    super::holds::wait_state(&s, &chat, &epics[2], "held").await?;
    data(
        s.gw.post(
            &format!("/sessions/{chat}/canon/queue/holds/{}", epics[1]),
            json!({"decision":"continue"}),
        )
        .await?,
        200,
    );
    wait_done(&s, &chat, 3).await?;
    for turn in s.gw.turns(&chat).await? {
        s.gw.wait_terminal(
            &chat,
            turn["id"].as_str().unwrap(),
            std::time::Duration::from_secs(60),
        )
        .await?;
    }
    script.quick.store(true, Ordering::SeqCst);
    let before = requests(&script).len();
    s.turn(&chat, "What does this mean?").await?;
    assert!(
        requests(&script)[before..]
            .iter()
            .all(|body| !body.contains("## Plan run in this conversation"))
    );
    // A new independent run in the same chat remains unfinished.
    let project =
        data(s.gw.get(&format!("/canon/epics/{first}")).await?, 200)["project_id"].clone();
    let epic = data(
        s.gw.post(
            &format!("/projects/{}/canon/epics", project.as_str().unwrap()),
            json!({"title":"Follow-up"}),
        )
        .await?,
        201,
    );
    data(
        s.gw.post(
            &format!("/sessions/{chat}/canon/queue"),
            json!({"op":"start_now","epic_id":epic["id"]}),
        )
        .await?,
        200,
    );
    super::holds::wait_state(&s, &chat, epic["id"].as_str().unwrap(), "running").await?;
    let before = requests(&script).len();
    s.turn(&chat, "What does this mean?").await?;
    let body = requests(&script)[before..].last().unwrap().clone();
    let note = &body[body.rfind("## Plan run in this conversation").unwrap()..];
    assert!(note.contains(epic["id"].as_str().unwrap()));
    for epic in epics {
        assert!(!note.contains(&format!("canon:epic/{epic}:")));
    }
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn compaction_keeps_latest_plan_run_note() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, script, server, first, chat) =
        crate::canon_link::setup("CB-NOTE-COMPACTION", false, false).await?;
    s.agent.terminate().await?;
    s.agent
        .launch
        .set_env("BUTLER_BOUNDED_STATELESS_CONTEXT", "1");
    s.agent
        .launch
        .set_env("BUTLER_CONTINUATION_MAX_MODEL_FACING_BYTES", "180000");
    s.gw = s.agent.start_again().await?;
    let (plan_id, epics) = plan(&s, &script, &first).await?;
    // Complete file responses create actual pressure; the summary call stays stubbed.
    std::fs::write(
        script.path.lock().unwrap().clone(),
        "Evidence line: checked and retained.\n".repeat(1600),
    )?;
    script.compaction.store(true, Ordering::SeqCst);
    run_plan(&s, &chat, &plan_id).await?;
    script.wait_held().await;
    let refs = note_refs(&script);
    let first_edit = edit(
        &s,
        &chat,
        json!({"op":"move_to_new_step","epic_id":refs[2],"index":1}),
    )
    .await?;
    script.release();
    script.wait_held().await;
    let latest = edit(
        &s,
        &chat,
        json!({"op":"move_to_new_step","epic_id":refs[1],"index":1}),
    )
    .await?;
    script.release();
    let turn = super::fixture::first_turn(&s, &chat).await?;
    s.gw.wait_terminal(&chat, &turn, std::time::Duration::from_secs(60))
        .await?;
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let count: usize = db.query_row("SELECT count(*) FROM btcc_context_compactions", [], |r| {
        r.get(0)
    })?;
    assert!(count > 0, "a real rolling compaction must have committed");
    let bodies = requests(&script);
    assert!(
        bodies
            .iter()
            .any(|body| body.contains("Summarize the previous summary"))
    );
    let body = bodies
        .iter()
        .rev()
        .find(|body| body.contains("Earlier working history (summary"))
        .expect("post-compaction request");
    let update = &body[body
        .rfind("Updated plan run;")
        .expect("latest status retained")..];
    assert!(update.contains(&format!("Revision {}.", latest["graph_revision"])));
    assert!(
        !body.contains(&format!("Revision {}.", first_edit["graph_revision"])),
        "old status survived compaction"
    );
    for epic in epics {
        assert!(update.contains(&format!("canon:epic/{epic}:")));
    }
    eprintln!(
        "CANON_COMPACTION records={count} latest_revision={}",
        latest["graph_revision"]
    );
    s.finish().await?;
    server.abort();
    Ok(())
}
