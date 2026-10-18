//! Delegated declarations use the real Steward relation and parent projection.
use super::super::steward_presentation::{self, stub as steward};
use super::*;

pub(crate) fn child(step: usize, work: &str) -> Value {
    match step {
        6 => write("scratch.txt", "Working notes"),
        7 => write("result.md", "Finished result"),
        8 => deliver("result.md", "Result"),
        9 => write("page.html", "<h1>Published</h1>"),
        10 => call("output_publish", json!({"path":"page.html","title":"Page"})),
        11 => call(
            "record_work_disposition",
            json!({"work_id":work,"disposition":"completed","summary":"Done","action_updates":[{"action_key":"compare","status":"done"}],"remaining_actions":[],"followups":[]}),
        ),
        _ => done(),
    }
}
#[tokio::test]
async fn worker_deliverables_and_published_outputs_belong_to_parent() -> Result<(), HarnessError> {
    use std::sync::atomic::Ordering;
    butler_e2e::gate!();
    let (url, script, server) = steward::start().await?;
    script.deliverables.store(true, Ordering::SeqCst);
    script.release.notify_one();
    let setup = steward_presentation::setup("DELIVERABLE-DELEGATION", &url)?;
    for name in ["a.txt", "b.txt"] {
        std::fs::write(setup.sandbox.data.join(name), name)?;
    }
    *script.workspace.lock().unwrap() = setup.sandbox.data.display().to_string();
    let s = setup.start().await?;
    s.turn("general", steward::OWNER).await?;
    steward_presentation::wait_result(&s).await?;
    let docs = documents(&s).await?;
    assert_eq!(docs.len(), 1, "{docs:?}");
    assert_eq!(docs[0]["session"], "general");
    assert_eq!(docs[0]["source"], "result.md");
    let message = last(&s).await?;
    assert!(
        message["attachments"]
            .as_array()
            .unwrap()
            .iter()
            .any(|f| f["deliverable"] == true && f["source_label"] == "result.md")
    );
    let outputs = s.gw.get("/library?kind=output").await?;
    let items = outputs.data()["items"].as_array().unwrap();
    assert_eq!(items.len(), 1, "{outputs:?}");
    assert_eq!(items[0]["session"], "general");
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn output_publish_stays_one_output_without_documents() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start().await?;
    *script.steps.lock().unwrap() = [
        write("site/index.html", "<h1>Page</h1>"),
        write("site/other.html", "<h1>Other</h1>"),
        call("output_publish", json!({"path":"site","title":"Page"})),
        done(),
    ]
    .into();
    let s = Setup::new("DELIVERABLE-OUTPUT")?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"))
        .start()
        .await?;
    run_turn(&s, &script, "Publish page.").await?;
    assert_eq!(documents(&s).await?, Vec::<Value>::new());
    let outputs = s.gw.get("/library?kind=output").await?;
    assert_eq!(outputs.data()["items"].as_array().unwrap().len(), 1);
    let id = outputs.data()["items"][0]["output"].as_str().unwrap();
    *script.steps.lock().unwrap() = [
        call(
            "output_publish",
            json!({"path":"site","entry":"other.html","title":"Page"}),
        ),
        done(),
    ]
    .into();
    run_turn(&s, &script, "Publish unchanged files again.").await?;
    let view = s.gw.get(&format!("/outputs/{id}/view")).await?;
    assert_eq!(
        view.data()["revisions"],
        json!([1]),
        "Unchanged file hashes must not add a revision"
    );
    assert_eq!(documents(&s).await?, Vec::<Value>::new());
    let message = last(&s).await?;
    assert!(
        message["artifacts"]
            .as_array()
            .unwrap()
            .iter()
            .any(|a| a["deliverable"] == true && a["source_label"].is_null())
    );

    s.finish().await?;
    server.abort();
    Ok(())
}
