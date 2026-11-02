//! Public gateway/provider handoffs: scope, contract, replacement, facts and paths.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
mod stub;
use butler_e2e::e2e::{
    HarnessError,
    scenario::{Scenario, Setup},
};
use serde_json::{Value, json};
use std::fmt::Write;
use std::time::{Duration, Instant};

const USER: &str = "조사해서 정리해줘.\n  원문과 공백을 그대로 보존해 주세요. 🦋";
const READING: &str = "Research and summarize as a styled HTML page";
const FACTS: &str = "Confirmed: the measured capacity is 42 units.\nopen gaps: the replacement date remains unknown.";
#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Verbatim,
    Document,
    Replace,
    Facts,
    Publish,
}

#[tokio::test]
async fn handoff_carries_verbatim_user_words_to_steward_and_worker() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server) = run(Mode::Verbatim).await?;
    let requests = script.requests.lock().unwrap().clone();
    for (role, label) in [
        ("steward", "user_request (the user's own words, verbatim): "),
        (
            "worker",
            "user_request (the user's own words, verbatim; context for your action, keep within its scope and output form): ",
        ),
    ] {
        let body = requests
            .iter()
            .find(|(r, _)| r == role)
            .unwrap()
            .1
            .to_string();
        let decoded = body.replace("\\n", "\n");
        assert!(decoded.contains(&format!("{label}{USER}")), "{body}");
        if role == "steward" {
            assert!(decoded.contains(&format!("request (Butler's reading): {READING}")));
        }
    }
    s.finish().await?;
    server.abort();
    Ok(())
}

/// The stub proves the document-first rule reaches every role and that scripted
/// document_create delivers a document; it cannot prove a real model's choice.
#[tokio::test]
async fn project_research_contract_reaches_every_role_and_script_delivers_documents()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server) = run(Mode::Document).await?;
    let requests = script.requests.lock().unwrap().clone();
    for role in ["butler", "steward", "worker"] {
        let bodies: String = requests
            .iter()
            .filter(|(r, _)| r == role)
            .map(|(_, b)| b.to_string())
            .collect();
        assert!(
            bodies.contains("In any role, finished research"),
            "{role}: {bodies}"
        );
        assert!(
            bodies.contains("the default for research findings and comparisons"),
            "{role}: {bodies}"
        );
        assert!(bodies.contains("research and comparisons go in document_create. Publish the path last revised and checked."), "{role} did not receive the output_publish description");
        assert!(
            bodies.contains("Publish the file that was last revised and checked"),
            "{role}: {bodies}"
        );
    }
    let docs = s.gw.get("/library?kind=doc").await?;
    assert_eq!(docs.status, 200, "{docs:?}");
    assert!(docs.text.contains("Research evidence"), "{}", docs.text);
    assert!(docs.text.contains("Research report"), "{}", docs.text);
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn replacement_stops_old_worker_and_marks_its_late_cancellation_as_evidence()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server) = run(Mode::Replace).await?;
    let requests = script.requests.lock().unwrap().clone();
    let outputs: Vec<Value> = requests
        .iter()
        .flat_map(|(_, b)| stub::outputs(b))
        .collect();
    let refused = outputs
        .iter()
        .find(|v| v["error"]["code"] == "action_worker_running")
        .unwrap();
    assert_eq!(
        refused["running_relation_id"],
        *script.first_relation.lock().unwrap()
    );
    let db = db(&s)?;
    let (old, new): (String, String) = db.query_row("SELECT relation_id,json_extract(packet_json,'$.superseded_by') FROM btcc_subsession_delegations WHERE json_extract(packet_json,'$.superseded_by') IS NOT NULL", [], |r| Ok((r.get(0)?, r.get(1)?)))?;
    let prefix = format!(
        "Superseded Worker result: {old} was replaced by {new} for action A; it is not this action's result."
    );
    assert!(
        requests
            .iter()
            .any(|(r, b)| r == "steward" && b.to_string().contains(&prefix))
    );
    assert!(
        script
            .replacement_settled
            .load(std::sync::atomic::Ordering::SeqCst),
        "replacement provider input must follow old result settlement"
    );
    let view = s.gw.get("/session-view?session_id=general").await?;
    assert_eq!(view.data()["steward_children"][0]["approved_plan_total"], 1);
    assert_eq!(
        view.data()["steward_children"][0]["approved_plan_completed"],
        1
    );
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn next_action_receives_confirmed_facts_gaps_and_an_openable_reference()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server) = run(Mode::Facts).await?;
    let requests = script.requests.lock().unwrap().clone();
    let next: Vec<_> = requests
        .iter()
        .filter(|(r, b)| r == "worker" && b.to_string().contains("assigned_objective: next step"))
        .collect();
    assert_ne!(next.len(), 0);
    let text = next[0].1.to_string();
    assert!(
        text.contains("earlier_steps: Results of the actions this one depends on."),
        "{text}"
    );
    assert!(text.contains("- A (session cs_"), "{text}");
    assert!(text.contains("Confirmed: the measured capacity is 42 units."));
    assert!(text.contains("open gaps: the replacement date remains unknown."));
    let opened = next
        .iter()
        .flat_map(|(_, b)| stub::outputs(b))
        .find(|v| {
            v["bridge_invocation"]["id"] == "native:read_conversation_session"
                && v.to_string()
                    .contains("Confirmed: the measured capacity is 42 units.")
        })
        .unwrap();
    assert_eq!(opened["ok"], true, "{opened}");
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn publishing_refuses_a_different_file_then_accepts_the_revision_target()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server) = run(Mode::Publish).await?;
    let worker_outputs: Vec<Value> = script
        .requests
        .lock()
        .unwrap()
        .iter()
        .filter(|(role, _)| role == "worker")
        .flat_map(|(_, body)| stub::outputs(body))
        .filter(|value| {
            value["tool_name"] == "write_file"
                || value["bridge_invocation"]["id"] == "native:read_file"
        })
        .collect();
    assert_ne!(worker_outputs.len(), 0);
    assert!(
        worker_outputs.iter().all(|value| value["ok"] == true),
        "{worker_outputs:?}"
    );
    let outputs: Vec<Value> = script
        .requests
        .lock()
        .unwrap()
        .iter()
        .filter(|(r, _)| r == "steward")
        .flat_map(|(_, b)| stub::outputs(b))
        .collect();
    let refusal = outputs
        .iter()
        .find(|v| v["error"]["code"] == "publish_target_mismatch")
        .unwrap();
    assert_eq!(
        refusal["error"]["message"],
        "The latest revision and check in this Work were on site/index.html, not site/page.html. Publish site/index.html, or assign the revision of site/page.html with target_path before publishing it."
    );
    assert!(
        outputs.iter().any(|v| v["output_id"].is_string()),
        "{outputs:?}"
    );
    s.finish().await?;
    server.abort();
    Ok(())
}

fn db(s: &Scenario) -> Result<rusqlite::Connection, HarnessError> {
    Ok(rusqlite::Connection::open(
        s.sandbox.data.join("agent-runtime/btcc.sqlite"),
    )?)
}
async fn run(
    mode: Mode,
) -> Result<
    (
        Scenario,
        std::sync::Arc<stub::Script>,
        tokio::task::JoinHandle<()>,
    ),
    HarnessError,
> {
    let (url, script, server) = stub::start(mode).await?;
    let mut s = Setup::new("DELEGATION-HANDOFF")?
        .cassette("TOOL-01")
        .env("BUTLER_CHATGPT_API_BASE_URL", &url)
        .start()
        .await?;
    let chat = if matches!(mode, Mode::Document | Mode::Publish) {
        let folder = s.sandbox.root.join("projects");
        std::fs::create_dir_all(&folder)?;
        crate::project_workspace::bind_project(&mut s, &folder).await?
    } else {
        "general".into()
    };
    *script.data.lock().unwrap() = s.sandbox.data.clone();
    s.turn(&chat, USER).await?;
    let deadline = Instant::now() + Duration::from_secs(45);
    loop {
        let settled: bool = db(&s)?.query_row("SELECT EXISTS(SELECT 1 FROM btcc_subsession_delegations d JOIN btcc_steward_results x USING(relation_id) JOIN btcc_subsession_outbox o USING(result_id) WHERE json_extract(d.packet_json,'$.child_role')='steward' AND x.status='success' AND o.status='delivered')", [], |r| r.get(0))?;
        if settled {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "stage={} last_outputs={:?}",
            script.stage.load(std::sync::atomic::Ordering::SeqCst),
            script
                .requests
                .lock()
                .unwrap()
                .last()
                .map(|(_, body)| stub::outputs(body)
                    .into_iter()
                    .rev()
                    .take(3)
                    .collect::<Vec<_>>())
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    Ok((s, script, server))
}
