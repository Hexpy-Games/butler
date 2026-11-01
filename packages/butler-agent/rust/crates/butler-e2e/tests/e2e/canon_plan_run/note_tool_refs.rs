//! The model copies the note's refs unchanged into actual canon_queue calls.
use super::run_note::{note_refs, requests, run_plan};
use super::*;
use serde_json::Value;
use std::sync::atomic::Ordering;

#[tokio::test]
async fn model_queue_calls_copy_note_refs_unchanged() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, first, chat) =
        crate::canon_link::setup("CB-NOTE-TOOL-REFS", false, false).await?;
    let (plan_id, epics) = plan(&s, &script, &first).await?;
    script.blocked.lock().unwrap().push(first.clone());
    script.release();
    run_plan(&s, &chat, &plan_id).await?;
    super::holds::wait_state(&s, &chat, &epics[1], "held").await?;
    for op in ["set_order", "after"] {
        // Get a new model request with the current note, then copy its literal refs.
        script.quick.store(true, Ordering::SeqCst);
        s.turn(&chat, "What does this mean?").await?;
        let refs = note_refs(&script);
        assert_eq!(refs.len(), 3);
        let view = data(
            s.gw.get(&format!("/sessions/{chat}/canon/queue")).await?,
            200,
        );
        let args = if op == "set_order" {
            json!({"op":op,"expected_revision":view["graph_revision"],"steps":[[refs[2]],[refs[1]]]})
        } else {
            json!({"op":op,"expected_revision":view["graph_revision"],"epic_id":refs[2],"target_epic_id":refs[0]})
        };
        *script.queue_request.lock().unwrap() = Some(args.clone());
        let before = requests(&script).len();
        s.turn(&chat, "Queue this epic").await?;
        let calls: Vec<Value> = script.requests.lock().unwrap()[before..]
            .iter()
            .flat_map(|body| body["input"].as_array().unwrap())
            .filter(|item| item["type"] == "function_call" && item["name"] == "canon_queue")
            .map(|item| serde_json::from_str(item["arguments"].as_str().unwrap()).unwrap())
            .collect();
        assert!(calls.contains(&args), "model arguments changed: {calls:?}");
        assert!(
            script.codes.lock().unwrap().is_empty(),
            "{:?}",
            script.codes.lock().unwrap()
        );
        let next = data(
            s.gw.get(&format!("/sessions/{chat}/canon/queue")).await?,
            200,
        );
        assert!(next["graph_revision"].as_i64() > view["graph_revision"].as_i64());
        assert_eq!(
            next["chains"][0]["steps"][1]["items"][0]["epic_id"],
            refs[2].strip_prefix("canon:epic/").unwrap()
        );
    }
    s.finish().await?;
    server.abort();
    Ok(())
}

#[tokio::test]
async fn model_queue_revision_errors_reach_model_verbatim() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, first, chat) =
        crate::canon_link::setup("CB-NOTE-TOOL-ERRORS", false, false).await?;
    let (plan_id, epics) = plan(&s, &script, &first).await?;
    script.blocked.lock().unwrap().push(first.clone());
    script.release();
    run_plan(&s, &chat, &plan_id).await?;
    super::holds::wait_state(&s, &chat, &epics[1], "held").await?;
    script.quick.store(true, Ordering::SeqCst);
    s.turn(&chat, "What does this mean?").await?;
    let refs = note_refs(&script);
    let view = data(
        s.gw.get(&format!("/sessions/{chat}/canon/queue")).await?,
        200,
    );
    let current = view["graph_revision"].as_i64().unwrap();
    let expected = current - 1;
    for (args, message) in [
        (
            json!({"op":"after","expected_revision":expected,"epic_id":refs[2],"target_epic_id":refs[0]}),
            format!(
                "The run changed since revision {expected}; it is now at revision {current}. Read the order in the latest plan run note and send the change again with that revision."
            ),
        ),
        (
            json!({"op":"set_order","steps":[[refs[2]],[refs[1]]]}),
            "expected_revision required: pass the revision from the latest plan run note."
                .to_owned(),
        ),
    ] {
        *script.queue_request.lock().unwrap() = Some(args);
        let before = requests(&script).len();
        s.turn(&chat, "Queue this epic").await?;
        assert_tool_error(&script, before, &message);
    }
    s.finish().await?;
    server.abort();
    Ok(())
}

fn assert_tool_error(script: &crate::canon_link::stub::Script, before: usize, message: &str) {
    let captured = script.requests.lock().unwrap();
    let outputs: Vec<Value> = captured[before..]
        .iter()
        .flat_map(|body| body["input"].as_array().unwrap())
        .filter(|item| {
            item["type"] == "function_call_output"
                && item["call_id"]
                    .as_str()
                    .is_some_and(|id| id.starts_with("canon-flow-"))
        })
        .map(|item| serde_json::from_str(item["output"].as_str().unwrap()).unwrap())
        .collect();
    assert!(
        !outputs.is_empty(),
        "the model must receive the tool refusal"
    );
    for output in outputs {
        assert!(
            !output.to_string().contains("expected_graph_revision"),
            "{output}"
        );
        let output = output.get("output").unwrap_or(&output);
        assert_eq!(output["error"]["message"], message, "{output}");
    }
}
