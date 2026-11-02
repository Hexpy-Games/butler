//! A blocked project assignment closes canonically; new work gets a new card.
use super::*;
use std::sync::atomic::Ordering;

#[tokio::test]
async fn blocked_project_followup_rejected_plan_reaches_new_terminal_card()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start(false).await?;
    script.blocked.store(true, Ordering::SeqCst);
    let s = Setup::new("PROJECT-FOLLOWUP-PLAN-REJECTION")?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"))
        .start()
        .await?;
    let project =
        s.gw.post(
            "/projects",
            json!({"source":"scratch","display_name":"Source verification"}),
        )
        .await?;
    assert_eq!(project.status, 201, "{project:?}");
    let project_id = project.data()["project"]["id"].as_str().unwrap();
    let parent =
        s.gw.post(
            "/sessions",
            json!({"kind":"project","title":"Verification","project_id":project_id}),
        )
        .await?;
    let parent = parent.data()["session"]["id"].as_str().unwrap();
    s.turn(parent, stub::OWNER).await?;
    let first = wait_project_result(&s, parent, None).await?;
    assert_eq!(first["result"]["status"], "blocked");
    terminal::assert_closed(&s, &first);
    let old_work = script.work.lock().unwrap().clone();
    let ledger = s
        .sandbox
        .data
        .join("project-ledger/projects")
        .join(project_id);
    let old_path = ledger.join("work").join(&old_work).join("work.md");
    let old_bytes = std::fs::read(&old_path)?;
    assert_canonical_closed(&ledger, &old_path)?;
    *script.relation.lock().unwrap() = first["relation"]["relation_id"].as_str().unwrap().into();
    script.blocked.store(false, Ordering::SeqCst);
    script.invalid_followup_plan.store(true, Ordering::SeqCst);
    s.turn(parent, stub::FOLLOWUP).await?;
    tokio::time::timeout(Duration::from_secs(30), script.held.notified())
        .await
        .unwrap();
    let new_work = script.work.lock().unwrap().clone();
    assert_ne!(old_work, new_work);
    let new_path = ledger.join("work").join(&new_work).join("work.md");
    let revised = record(&new_path)?;
    assert_eq!(
        revised["planRevision"], 1,
        "invalid plan must not create a revision"
    );
    let requests = script.requests.lock().unwrap().clone();
    assert!(
        requests
            .iter()
            .any(|r| r.to_string().contains("work_update_rejected")),
        "plan error must reach the model"
    );
    assert_eq!(
        std::fs::read(&old_path)?,
        old_bytes,
        "new work must not mutate ended authority"
    );
    script.release.notify_one();
    let second = wait_project_result(&s, parent, Some(&first)).await?;
    assert_ne!(second["session_id"], first["session_id"]);
    assert_ne!(
        second["relation"]["anchor_message_id"],
        first["relation"]["anchor_message_id"]
    );
    assert_eq!(second["result"]["status"], "success");
    terminal::assert_closed(&s, &second);
    assert_eq!(record(&new_path)?["status"], "completed");
    assert_eq!(std::fs::read(&old_path)?, old_bytes);
    s.finish().await?;
    server.abort();
    Ok(())
}

async fn wait_project_result(
    s: &Scenario,
    parent: &str,
    previous: Option<&Value>,
) -> Result<Value, HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let view =
            s.gw.get(&format!("/session-view?session_id={parent}"))
                .await?;
        if let Some(child) = view.data()["steward_children"]
            .as_array()
            .unwrap()
            .iter()
            .find(|child| {
                child["terminal"] == true
                    && child["result"].is_object()
                    && previous.is_none_or(|prior| prior["session_id"] != child["session_id"])
            })
        {
            return Ok(child.clone());
        }
        assert!(Instant::now() < deadline, "{view:?}\n{}", s.agent.logs());
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn record(path: &std::path::Path) -> Result<Value, HarnessError> {
    let raw = std::fs::read_to_string(path)?;
    let (_, body) = raw.split_once("\n---\n").expect("Ledger frontmatter");
    Ok(serde_json::from_str(body.trim())?)
}

fn assert_canonical_closed(
    ledger: &std::path::Path,
    work: &std::path::Path,
) -> Result<(), HarnessError> {
    let manifest = record(work)?;
    assert_eq!(manifest["status"], "abandoned");
    assert!(
        manifest["actionProgress"]
            .as_array()
            .unwrap()
            .iter()
            .all(|action| matches!(action["status"].as_str(), Some("done" | "skipped")))
    );
    let id = manifest["latestCheckpointRevisionId"].as_str().unwrap();
    let checkpoint = record(
        &ledger
            .join("references")
            .join(format!("{}.md", id.to_lowercase())),
    )?;
    assert_eq!(
        checkpoint["checkpoint"]["actionProgress"],
        manifest["actionProgress"]
    );
    assert_eq!(checkpoint["checkpoint"]["stage"], "reporting");
    assert_eq!(
        checkpoint["checkpoint"]["revision"],
        manifest["checkpointRevision"]
    );
    Ok(())
}
