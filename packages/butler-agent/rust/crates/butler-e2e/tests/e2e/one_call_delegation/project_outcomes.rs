//! A project handoff preserves earlier owners and maps non-success results.
use super::*;
use butler_e2e::e2e::scenario::{Scenario, accepted_turn_id};
use std::sync::{Arc, atomic::Ordering};

#[tokio::test]
async fn project_blocked_result_settles_parent_without_reviews() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    outcome(false, false).await
}

#[tokio::test]
async fn project_cancelled_result_abandons_parent_without_reviews() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    outcome(true, false).await
}

#[tokio::test]
async fn second_project_handoff_preserves_the_first_active_work_and_binding_history()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    outcome(false, true).await
}

async fn outcome(cancelled: bool, twice: bool) -> Result<(), HarnessError> {
    let (s, script, server, project, chat) = setup().await?;
    script.blocked.store(!cancelled && !twice, Ordering::SeqCst);
    let accepted = s.gw.say(&chat, stub::REQUEST).await?;
    let turn = accepted_turn_id(&accepted)?;
    tokio::time::timeout(Duration::from_secs(30), script.held.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    s.gw.wait_terminal(&chat, &turn, Duration::from_secs(30))
        .await?;
    if twice {
        s.turn(&chat, stub::REQUEST).await?;
    }
    let relations = relations(&s)?;
    assert_eq!(relations.len(), if twice { 2 } else { 1 });
    if cancelled {
        let reply =
            s.gw.post(
                &format!("/steward-relations/{}/cancel", relations[0]),
                json!({"parent_session_id":chat}),
            )
            .await?;
        assert_eq!(reply.status, 202, "{reply:?}");
        wait_cancelled(&s).await?;
    }
    script.release.add_permits(1);
    let expected = if cancelled {
        "abandoned"
    } else if twice {
        "completed"
    } else {
        "blocked"
    };
    let parents = parent_ids(&s)?;
    let deadline = Instant::now() + Duration::from_secs(40);
    loop {
        let manifests: Vec<_> = parents
            .iter()
            .map(|id| manifest(&s, &project, id))
            .collect::<Result<_, _>>()?;
        if manifests.iter().all(|view| view["status"] == expected) {
            for view in &manifests {
                assert_eq!(view["planRevision"], 1);
                assert_eq!(view["reviewRevision"], 0);
                assert_eq!(view["currentStage"], "reporting");
            }
            if twice {
                assert!(manifests.iter().any(|view| view["sessionHead"] == false));
                assert!(
                    manifests
                        .iter()
                        .all(|view| !view["bindingRefs"].as_array().unwrap().is_empty())
                );
            }
            break;
        }
        assert!(
            Instant::now() < deadline,
            "{manifests:?}\n{}",
            s.agent.logs()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(parents.len(), if twice { 2 } else { 1 });
    s.finish().await?;
    server.abort();
    Ok(())
}

async fn setup() -> Result<
    (
        Scenario,
        Arc<stub::Script>,
        tokio::task::JoinHandle<()>,
        String,
        String,
    ),
    HarnessError,
> {
    let (url, script, server) = stub::start().await?;
    let mut s = Setup::new("ONE-CALL-PROJECT-OUTCOME")?
        .cassette("TOOL-01")
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"))
        .start()
        .await?;
    let folder = s.sandbox.root.join("projects");
    std::fs::create_dir_all(&folder)?;
    let chat = crate::project_workspace::bind_project(&mut s, &folder).await?;
    let (project, workspace) = project::project_identity(&s)?;
    std::fs::write(workspace.join("source.txt"), "source evidence")?;
    *script.workspace.lock().unwrap() = workspace;
    Ok((s, script, server, project, chat))
}

fn parent_ids(s: &Scenario) -> Result<Vec<String>, HarnessError> {
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let mut query = db.prepare("SELECT json_extract(packet_json,'$.parent_work_ref.work_id') FROM btcc_subsession_delegations ORDER BY rowid")?;
    Ok(query
        .query_map([], |row| row.get(0))?
        .collect::<Result<_, _>>()?)
}

fn manifest(s: &Scenario, project: &str, work: &str) -> Result<Value, HarnessError> {
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

async fn wait_cancelled(s: &Scenario) -> Result<(), HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
        let statuses: Vec<String> = db
            .prepare("SELECT status FROM btcc_steward_results")?
            .query_map([], |row| row.get(0))?
            .collect::<Result<_, _>>()?;
        if statuses.iter().any(|status| status == "cancelled") {
            return Ok(());
        }
        assert!(
            Instant::now() < deadline,
            "Cancellation did not commit: {statuses:?}\n{}",
            s.agent.logs()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}
