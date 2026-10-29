//! Project Ledger parent and child Work, including a crash before delegation.
use super::*;
use butler_e2e::e2e::scenario::{Scenario, accepted_turn_id};
use tokio::io::AsyncReadExt;

#[tokio::test]
async fn project_parent_and_ledger_steward_settle_in_one_call() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    project_flow(false, false).await
}

#[tokio::test]
async fn project_plan_survives_crash_and_journal_replay_without_duplicates()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    project_flow(true, false).await
}

#[tokio::test]
async fn project_result_outbox_retries_settlement_after_restart() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    project_flow(false, true).await
}

async fn project_flow(crash: bool, settle_crash: bool) -> Result<(), HarnessError> {
    let barrier = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let (url, script, server) = stub::start().await?;
    let mut setup = Setup::new("ONE-CALL-PROJECT")?
        .cassette("TOOL-01")
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"));
    if crash {
        setup = setup.env(
            "BUTLER_E2E_HANDOFF_PLAN_BARRIER",
            barrier.local_addr()?.to_string(),
        );
    }
    if settle_crash {
        setup = setup.env(
            "BUTLER_E2E_RESULT_SETTLEMENT_BARRIER",
            barrier.local_addr()?.to_string(),
        );
    }
    let mut s = setup.start().await?;
    let folder = s.sandbox.root.join("projects");
    std::fs::create_dir_all(&folder)?;
    let chat = crate::project_workspace::bind_project(&mut s, &folder).await?;
    let (project, workspace) = project_identity(&s)?;
    *script.workspace.lock().unwrap() = workspace.clone();
    std::fs::write(workspace.join("source.txt"), "source evidence")?;
    bind_epic(&s, &script, &project, &chat).await?;
    let accepted = s.gw.say(&chat, stub::REQUEST).await?;
    let turn = accepted_turn_id(&accepted)?;
    if crash {
        crash_plan(&mut s, &barrier, &project, &turn, &chat).await?;
    }
    tokio::time::timeout(Duration::from_secs(30), script.held.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    s.gw.wait_terminal(&chat, &turn, Duration::from_secs(30))
        .await?;
    let active = parent_manifest(&s, &project, &turn)?;
    assert_eq!(active["planRevision"], 1);
    assert_eq!(active["reviewRevision"], 0);
    assert_eq!(relations(&s)?.len(), 1);
    assert_epic_running(&s, &script).await?;
    let parent_work = active["workId"].as_str().unwrap().to_owned();
    *script.parent_work.lock().unwrap() = parent_work;
    script
        .legacy_closeout
        .store(true, std::sync::atomic::Ordering::SeqCst);
    script.release.add_permits(1);
    if settle_crash {
        let (mut socket, _) = tokio::time::timeout(Duration::from_secs(30), barrier.accept())
            .await
            .unwrap()?;
        let mut marker = [0; 8];
        socket.read_exact(&mut marker).await?;
        assert_eq!(&marker, b"admitted");
        assert_eq!(parent_manifest(&s, &project, &turn)?["status"], "open");
        s.agent
            .launch
            .remove_env("BUTLER_E2E_RESULT_SETTLEMENT_BARRIER");
        s.crash_and_restart().await?;
    }
    wait_answer(&s, &chat).await?;
    verify_public_records(&s, &project, &active).await?;
    verify_project(&s, &script, &project, &turn)?;
    assert_eq!(
        std::fs::read_to_string(workspace.join("evidence.txt"))?,
        "verified"
    );
    assert!(!workspace.join("early.txt").exists());
    assert!(!workspace.join("revision.txt").exists());
    s.finish().await?;
    server.abort();
    Ok(())
}

pub(super) fn project_identity(s: &Scenario) -> Result<(String, std::path::PathBuf), HarnessError> {
    let db = rusqlite::Connection::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    Ok(db.query_row(
        "SELECT id,workspace_path FROM projects WHERE display_name='작업 Project'",
        [],
        |row| {
            Ok((
                row.get(0)?,
                std::path::PathBuf::from(row.get::<_, String>(1)?),
            ))
        },
    )?)
}

async fn bind_epic(
    s: &Scenario,
    script: &stub::Script,
    project: &str,
    chat: &str,
) -> Result<(), HarnessError> {
    let epic =
        s.gw.post(
            &format!("/projects/{project}/canon/epics"),
            json!({"title":"Evidence"}),
        )
        .await?;
    assert_eq!(epic.status, 201, "{epic:?}");
    let id = epic.data()["id"].as_str().unwrap();
    let linked =
        s.gw.post(
            &format!("/canon/epics/{id}/conversation"),
            json!({"session_id":chat}),
        )
        .await?;
    assert_eq!(linked.status, 200, "{linked:?}");
    *script.epic.lock().unwrap() = Some(format!("canon:epic/{id}"));
    Ok(())
}

async fn assert_epic_running(s: &Scenario, script: &stub::Script) -> Result<(), HarnessError> {
    let epic = script.epic.lock().unwrap().clone().unwrap();
    let id = epic.strip_prefix("canon:epic/").unwrap();
    let reply = s.gw.get(&format!("/canon/epics/{id}/progress")).await?;
    assert_eq!(reply.status, 200, "{reply:?}");
    assert_eq!(reply.data()["running"], true, "{reply:?}");
    Ok(())
}

pub(super) fn parent_manifest(
    s: &Scenario,
    project: &str,
    turn: &str,
) -> Result<Value, HarnessError> {
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let work: String = db.query_row(
        "SELECT work_id FROM btcc_guided_turn_work_bindings WHERE turn_id=?1 AND is_current=1",
        [turn],
        |row| row.get(0),
    )?;
    let path = s
        .sandbox
        .data
        .join("project-ledger/projects")
        .join(project)
        .join("work")
        .join(work)
        .join("work.md");
    let raw = std::fs::read_to_string(path)?;
    let (_, body) = raw.split_once("\n---\n").unwrap();
    Ok(serde_json::from_str(body.trim())?)
}

async fn wait_answer(s: &Scenario, chat: &str) -> Result<(), HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(40);
    loop {
        let messages = s.gw.messages(chat).await?;
        if messages
            .iter()
            .any(|message| message["text"] == stub::ANSWER)
        {
            return Ok(());
        }
        assert!(
            Instant::now() < deadline,
            "{messages:?}\n{}",
            s.agent.logs()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn verify_project(
    s: &Scenario,
    script: &stub::Script,
    project: &str,
    turn: &str,
) -> Result<(), HarnessError> {
    let manifest = parent_manifest(s, project, turn)?;
    assert_eq!(manifest["status"], "completed", "{manifest}");
    assert_eq!(manifest["planRevision"], 1);
    assert_eq!(manifest["reviewRevision"], 0);
    assert_eq!(manifest["dispositionRevision"], 1);
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let counts: (i64, i64, i64) = db.query_row("SELECT (SELECT count(*) FROM btcc_subsession_delegations), (SELECT count(*) FROM btcc_guided_tool_calls WHERE tool_name='delegate_to_steward'), (SELECT count(*) FROM btcc_guided_works WHERE scope_kind='project')", [], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)))?;
    assert_eq!(counts, (1, 1, 2), "One Ledger parent and one Ledger child");
    let (child_scope, acknowledgement): (String, String) = db.query_row("SELECT w.scope_kind,c.result_json FROM btcc_subsession_delegations d JOIN btcc_guided_works w ON w.work_id=d.root_work_id JOIN btcc_guided_tool_calls c ON c.tool_name='record_work_disposition' AND json_extract(c.result_json,'$.already_settled')=1", [], |row| Ok((row.get(0)?,row.get(1)?)))?;
    assert_eq!(child_scope, "project");
    assert_eq!(
        serde_json::from_str::<Value>(&acknowledgement)?["already_settled"],
        true
    );
    let requests = script.requests.lock().unwrap();
    assert!(
        requests
            .iter()
            .flat_map(stub::outputs)
            .any(|output| output["error"]["code"] == "steward_plan_review_required")
    );
    let refused: i64 = db.query_row("SELECT count(*) FROM btcc_guided_tool_calls WHERE json_extract(result_json,'$.error.code')='steward_plan_review_required'", [], |row| row.get(0))?;
    assert_eq!(refused, 3, "Each refused mutation is journaled once");
    Ok(())
}

async fn crash_plan(
    s: &mut Scenario,
    barrier: &tokio::net::TcpListener,
    project: &str,
    turn: &str,
    chat: &str,
) -> Result<(), HarnessError> {
    let (mut socket, _) = tokio::time::timeout(Duration::from_secs(30), barrier.accept())
        .await
        .unwrap()?;
    let mut marker = [0; 7];
    socket.read_exact(&mut marker).await?;
    assert_eq!(&marker, b"planned");
    assert_eq!(relations(s)?.len(), 0);
    let before = parent_manifest(s, project, turn)?;
    assert_eq!(before["status"], "open");
    assert_eq!(before["planRevision"], 1);
    s.agent.launch.remove_env("BUTLER_E2E_HANDOFF_PLAN_BARRIER");
    s.crash_and_restart().await?;
    let interrupted =
        s.gw.wait_terminal(chat, turn, Duration::from_secs(30))
            .await?;
    assert_eq!(interrupted["state"], "failed", "{interrupted}");
    assert_eq!(parent_manifest(s, project, turn)?["status"], "open");
    let retry =
        s.gw.post(&format!("/turns/{turn}/retry"), json!({}))
            .await?;
    assert_eq!(retry.status, 202, "{retry:?}");
    Ok(())
}

async fn verify_public_records(
    s: &Scenario,
    project: &str,
    active: &Value,
) -> Result<(), HarnessError> {
    let history =
        s.gw.get(&format!("/projects/{project}/dashboard/history?limit=100"))
            .await?;
    assert_eq!(history.status, 200, "{history:?}");
    assert_eq!(history.data()["ledgerUnavailable"], false);
    let parent = active["workId"].as_str().unwrap();
    assert!(
        history.data()["events"]
            .as_array()
            .unwrap()
            .iter()
            .any(|event| event["source"]["id"]
                .as_str()
                .is_some_and(|id| id.starts_with(parent))),
        "{history:?}"
    );
    let materials =
        s.gw.get(&format!("/projects/{project}/dashboard/materials"))
            .await?;
    assert_eq!(materials.status, 200, "{materials:?}");
    assert_eq!(materials.data()["status"], "ready");
    assert!(
        materials.data()["documents"]
            .as_array()
            .unwrap()
            .iter()
            .any(|document| document["id"] == active["currentPlanRevisionId"]
                && document["kind"] == "plan"),
        "{materials:?}"
    );
    assert_eq!(
        active["materialSnapshot"]["currentPlan"]["checks"],
        json!(["Evidence verified"])
    );
    Ok(())
}
