//! Nothing can answer a conversation that was archived or deleted, so its Turns
//! and whole delegated subtree stop on every route that removes it.
use super::*;
use butler_e2e::e2e::scenario::Scenario;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

/// Nothing further can reach the model once no Turn or relation is open and no
/// direction or inbound event is waiting, so this state is the negative proof.
async fn wait_nothing_runs(s: &Scenario) -> Result<(), HarnessError> {
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let open: (i64, i64, i64) = db.query_row(
            "SELECT (SELECT count(*) FROM btcc_turns WHERE semantic_state IN ('admitted','delivery_committed')),
                    (SELECT count(*) FROM btcc_session_relations WHERE activity_terminal=0),
                    (SELECT count(*) FROM btcc_subsession_directions WHERE status='pending')",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;
        let inbound = s.sandbox.data.join("runtime/inbound-events");
        let queued = ["pending", "processing"]
            .iter()
            .filter_map(|state| std::fs::read_dir(inbound.join(state)).ok())
            .flatten()
            .count();
        if open == (0, 0, 0) && queued == 0 {
            return Ok(());
        }
        assert!(
            Instant::now() < deadline,
            "still open: {open:?}, {queued} queued"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn model_calls(script: &crate::canon_link::stub::Script) -> usize {
    script.requests.lock().unwrap().len()
}

async fn run_plan(s: &Scenario, chat: &str, plan: &str) -> Result<(), HarnessError> {
    data(
        s.gw.post(
            &format!("/sessions/{chat}/canon/queue"),
            json!({"op":"plan_run","plan_id":plan}),
        )
        .await?,
        200,
    );
    Ok(())
}

async fn delete_chat(s: &Scenario, chat: &str) -> Result<(), HarnessError> {
    data(
        s.gw.delete(&format!("/sessions/{chat}?permanent=true"))
            .await?,
        200,
    );
    Ok(())
}

async fn archive_chat(s: &Scenario, chat: &str) -> Result<(), HarnessError> {
    data(
        s.gw.post(&format!("/sessions/{chat}/archive"), json!({}))
            .await?,
        200,
    );
    Ok(())
}

fn completed_works(s: &Scenario) -> Result<i64, HarnessError> {
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    Ok(db.query_row(
        "SELECT count(*) FROM btcc_guided_works WHERE status='completed'",
        [],
        |r| r.get(0),
    )?)
}

/// `remove` runs while the first step's model call is open; nothing may call again.
async fn stops_running_step<F>(name: &str, remove: F) -> Result<(), HarnessError>
where
    F: AsyncFnOnce(&Scenario, &str, &str) -> Result<(), HarnessError>,
{
    let (s, script, server, first, chat) = crate::canon_link::setup(name, false, false).await?;
    let project = data(s.gw.get(&format!("/canon/epics/{first}")).await?, 200)["project_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let (plan, _) = plan(&s, &script, &first).await?;
    run_plan(&s, &chat, &plan).await?;
    script.wait_held().await;
    let calls = model_calls(&script);
    remove(&s, &chat, &project).await?;
    wait_nothing_runs(&s).await?;
    script.release();
    wait_nothing_runs(&s).await?;
    assert_eq!(model_calls(&script), calls, "the model was called again");
    assert_eq!(
        completed_works(&s)?,
        0,
        "the stopped step finished its Work"
    );
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn deleting_chat_stops_its_running_step() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    stops_running_step("CB-STOP-DELETE", async |s, chat, _| {
        delete_chat(s, chat).await
    })
    .await
}

#[tokio::test]
async fn archiving_chat_stops_its_running_step() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    stops_running_step("CB-STOP-ARCHIVE", async |s, chat, _| {
        archive_chat(s, chat).await
    })
    .await
}

#[tokio::test]
async fn archiving_project_stops_its_running_step() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    stops_running_step("CB-STOP-PROJECT-ARCHIVE", async |s, _, project| {
        data(
            s.gw.post(&format!("/projects/{project}/archive"), json!({}))
                .await?,
            200,
        );
        Ok(())
    })
    .await
}

#[tokio::test]
async fn deleting_project_stops_its_running_step() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    stops_running_step("CB-STOP-PROJECT-DELETE", async |s, _, project| {
        data(
            s.gw.delete(&format!("/projects/{project}?permanent=true"))
                .await?,
            200,
        );
        Ok(())
    })
    .await
}

/// A delegated step has no live chat Turn: its Steward and that Steward's Workers stop.
#[tokio::test]
async fn deleting_chat_stops_its_whole_delegated_subtree() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, first, chat) =
        crate::canon_link::setup("CB-STOP-SUBTREE", false, false).await?;
    let (plan, _) = plan(&s, &script, &first).await?;
    script.delegate.store(true, Ordering::SeqCst);
    run_plan(&s, &chat, &plan).await?;
    script.wait_held().await;
    let calls = model_calls(&script);
    delete_chat(&s, &chat).await?;
    wait_nothing_runs(&s).await?;
    script.release();
    wait_nothing_runs(&s).await?;
    assert_eq!(
        model_calls(&script),
        calls,
        "the Worker kept calling the model"
    );
    s.finish().await?;
    server.abort();
    Ok(())
}

/// Archived, the chat survives, but nothing can finish its delegated step: it holds.
#[tokio::test]
async fn archiving_chat_holds_its_delegated_step() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, first, chat) =
        crate::canon_link::setup("CB-STOP-ARCHIVE-SUBTREE", false, false).await?;
    let (plan, epics) = plan(&s, &script, &first).await?;
    script.delegate.store(true, Ordering::SeqCst);
    run_plan(&s, &chat, &plan).await?;
    script.wait_held().await;
    let calls = model_calls(&script);
    archive_chat(&s, &chat).await?;
    wait_nothing_runs(&s).await?;
    script.release();
    wait_nothing_runs(&s).await?;
    assert_eq!(model_calls(&script), calls, "the subtree kept running");
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    wait_step_held(&db, &epics[0]).await?;
    drop(db);
    let row = data(s.gw.get(&format!("/canon/epics/{}", epics[0])).await?, 200);
    assert_eq!(row["running"], json!(false), "{row}");
    s.finish().await?;
    server.abort();
    Ok(())
}

async fn wait_approval(s: &Scenario, chat: &str) -> Result<(), HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(30);
    while s.gw.approval_requests(chat).await?.is_empty() {
        assert!(Instant::now() < deadline, "approval never appeared");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    Ok(())
}

async fn wait_step_held(db: &rusqlite::Connection, epic: &str) -> Result<(), HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let held: Option<String> = db.query_row(
            "SELECT hold_reason FROM canon_session_queue WHERE epic_id=?1",
            [epic],
            |r| r.get(0),
        )?;
        if held.is_some() {
            return Ok(());
        }
        assert!(Instant::now() < deadline, "the stopped step was not held");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// The App's route: 보관하기, then 설정 › 아카이브 › 삭제, with an approval card still open.
#[tokio::test]
async fn archive_then_delete_settles_step_waiting_for_approval() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, first, chat) =
        crate::canon_link::setup("CB-STOP-ROUTE", false, false).await?;
    let (plan, epics) = plan(&s, &script, &first).await?;
    data(
        s.gw.patch("/settings", json!({"access_mode":"ask_first"}))
            .await?,
        200,
    );
    let outside = s.sandbox.home.join("outside-the-workspace.txt");
    std::fs::write(&outside, "Needs an approval to read.")?;
    *script.path.lock().unwrap() = outside.to_string_lossy().into_owned();
    run_plan(&s, &chat, &plan).await?;
    wait_approval(&s, &chat).await?;
    let calls = model_calls(&script);
    archive_chat(&s, &chat).await?;
    wait_nothing_runs(&s).await?;
    assert_eq!(
        model_calls(&script),
        calls,
        "archiving left the step running"
    );
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    wait_step_held(&db, &epics[0]).await?;
    let row = data(s.gw.get(&format!("/canon/epics/{}", epics[0])).await?, 200);
    assert_eq!(row["running"], json!(false), "{row}");
    let app = rusqlite::Connection::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    let archived: i64 = app.query_row("SELECT archived FROM chats WHERE id=?1", [&chat], |r| {
        r.get(0)
    })?;
    assert_eq!(archived, 1, "the hold card restored the chat");
    delete_chat(&s, &chat).await?;
    script.release();
    wait_nothing_runs(&s).await?;
    assert_eq!(
        model_calls(&script),
        calls,
        "the model was called after the delete"
    );
    let left: i64 = db.query_row("SELECT count(*) FROM canon_session_queue", [], |r| r.get(0))?;
    assert_eq!(left, 0, "the deleted chat kept queue rows");
    drop(db);
    drop(app);
    s.finish().await?;
    server.abort();
    Ok(())
}
