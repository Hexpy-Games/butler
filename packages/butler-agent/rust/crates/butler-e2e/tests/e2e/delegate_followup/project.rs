//! Project Work continuation must feed plan errors back and settle the child turn.
use super::*;
use std::sync::atomic::Ordering;

#[tokio::test]
async fn blocked_project_followup_rejected_plan_reaches_terminal() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start(false).await?;
    script.blocked.store(true, Ordering::SeqCst);
    script.routed.store(true, Ordering::SeqCst);
    script.hold_revision.store(true, Ordering::SeqCst);
    let s = Setup::new("PROJECT-FOLLOWUP-PLAN-REJECTION")?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{}/v1", url))
        .start()
        .await?;
    let project =
        s.gw.post(
            "/projects",
            json!({"source":"scratch","display_name":"Source verification"}),
        )
        .await?;
    assert_eq!(project.status, 201, "{project:?}");
    let parent = s.gw.post("/sessions", json!({"kind":"project","title":"Verification","project_id":project.data()["project"]["id"]})).await?;
    assert_eq!(parent.status, 201, "{parent:?}");
    let parent = parent.data()["session"]["id"].as_str().unwrap();
    s.turn(parent, stub::OWNER).await?;
    let first = wait_project_result(&s, parent, None).await?;
    assert_eq!(first["result"]["status"], "blocked", "{first}");
    assert_eq!(first["approved_plan_revision"], 1, "{first}");
    let project_id = project.data()["project"]["id"].as_str().unwrap();
    let work_id = script.work.lock().unwrap().clone();
    let ledger = s
        .sandbox
        .data
        .join("project-ledger/projects")
        .join(project_id);
    let manifest_path = ledger.join("work").join(&work_id).join("work.md");
    let original = record(&manifest_path)?;
    let disposition_id = original["latestDispositionRevisionId"].as_str().unwrap();
    let disposition_path = ledger
        .join("references")
        .join(format!("{disposition_id}.md"));
    let disposition_bytes = std::fs::read(&disposition_path)?;
    let old_disposition = record(&disposition_path)?;
    assert_eq!(old_disposition["disposition"]["disposition"], "blocked");
    assert_eq!(
        old_disposition["disposition"]["materialFingerprint"],
        original["materialFingerprint"]
    );
    *script.relation.lock().unwrap() = first["relation"]["relation_id"].as_str().unwrap().into();
    let (_, turn) = s.turn(parent, stub::FOLLOWUP).await?;
    assert_eq!(turn["state"], "delivered");
    tokio::time::timeout(Duration::from_secs(30), script.held.notified())
        .await
        .expect("revised plan must remain readable before its new review");
    let revised = record(&manifest_path)?;
    let feedback = {
        let requests = script.requests.lock().unwrap();
        requests
            .last()
            .and_then(|body| body["input"].as_array())
            .and_then(|items| items.iter().rev().find_map(|item| item["output"].as_str()))
            .map(str::to_owned)
    };
    assert_eq!(revised["planRevision"], 2, "{revised}\n{feedback:?}");
    assert_eq!(revised["status"], "open");
    assert_eq!(revised["currentStage"], "planning");
    assert!(
        revised["latestDispositionRevisionId"].is_null(),
        "{revised}"
    );
    assert_eq!(revised["dispositionRevision"], 1);
    assert_ne!(
        revised["materialFingerprint"],
        original["materialFingerprint"]
    );
    let view =
        s.gw.get(&format!(
            "/session-view?session_id={}",
            first["session_id"].as_str().unwrap()
        ))
        .await?;
    assert_eq!(view.status, 200, "{view:?}");
    assert!(
        view.data()["approved_plan_revision"].is_null(),
        "old approval authorized revised plan: {view:?}"
    );
    assert_eq!(std::fs::read(&disposition_path)?, disposition_bytes);
    assert_history(&s, project_id, &work_id, disposition_id).await?;
    script.release.notify_one();
    let second = wait_project_result(&s, parent, Some(&first)).await?;
    assert_eq!(second["session_id"], first["session_id"]);
    assert_eq!(second["result"]["status"], "success", "{second}");
    assert_terminal(&s, &second).await?;
    assert_eq!(std::fs::read(&disposition_path)?, disposition_bytes);
    let settled = record(&manifest_path)?;
    assert_eq!(settled["dispositionRevision"], 2);
    assert_ne!(
        settled["latestDispositionRevisionId"],
        original["latestDispositionRevisionId"]
    );
    assert_history(&s, project_id, &work_id, disposition_id).await?;
    let requests = script.requests.lock().unwrap().clone();
    let messages: Vec<_> = requests
        .iter()
        .filter(|body| {
            butler_e2e::e2e::matching::key("/v1/responses", body, &Default::default())
                .user_request
                .starts_with(stub::MESSAGE)
        })
        .collect();
    assert_eq!(messages.len(), 6, "{messages:?}\n{}", s.agent.logs());
    assert!(messages[2].to_string().contains("work_update_rejected"));
    assert!(
        !s.agent.logs().contains("Turn interrupted"),
        "{}",
        s.agent.logs()
    );
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
        let children = view.data()["steward_children"].as_array().unwrap();
        if let Some(child) = children.first()
            && child["result"].is_object()
            && previous.is_none_or(|prior| {
                prior["result"]["child_turn_id"] != child["result"]["child_turn_id"]
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

async fn assert_history(
    s: &Scenario,
    project: &str,
    work: &str,
    disposition: &str,
) -> Result<(), HarnessError> {
    let history =
        s.gw.get(&format!("/projects/{project}/dashboard/history?limit=100"))
            .await?;
    assert_eq!(history.status, 200, "{history:?}");
    assert_eq!(history.data()["ledgerUnavailable"], false, "{history:?}");
    let expected = format!("{work}|{disposition}");
    let entry = history.data()["events"]
        .as_array()
        .unwrap()
        .iter()
        .find(|event| event["source"]["id"] == expected)
        .expect("superseded disposition remains in public Ledger history");
    let revision = entry["source"]["revision"].as_str().unwrap();
    let source = s.gw.get(&format!("/projects/{project}/dashboard/source?kind=reference&id={work}%7C{disposition}&revision={revision}")).await?;
    assert_eq!(source.status, 200, "{source:?}");
    assert!(
        source.data()["markdown"]
            .as_str()
            .unwrap()
            .contains("Source unavailable"),
        "{source:?}"
    );
    Ok(())
}

async fn assert_terminal(s: &Scenario, child: &Value) -> Result<(), HarnessError> {
    let session = child["session_id"].as_str().unwrap();
    let turn = child["result"]["child_turn_id"].as_str().unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let view =
            s.gw.get(&format!("/session-view?session_id={session}"))
                .await?;
        assert_eq!(view.status, 200, "{view:?}");
        let latest = &view.data()["latest_turn"];
        if latest["id"] == turn && latest["state"] == "delivered" {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "child turn did not settle: {view:?}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite")).unwrap();
    let state: String = db
        .query_row(
            "SELECT semantic_state FROM btcc_turns WHERE turn_id=?1",
            [turn],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(state, "delivered", "child turn must leave admitted state");
    Ok(())
}
