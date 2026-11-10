use super::*;
use butler_e2e::e2e::chatgpt_wire::functions;
use std::time::{Duration, Instant};

const REQUEST: &str = "Make a picture of a kite";

/// The image tool output the App reads from a child's own activity log.
async fn child_image_output(f: &Fixture, session: &str) -> Result<String, HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let view =
            f.s.gw
                .get(&format!("/session-view?session_id={session}"))
                .await?;
        let turn = view.data()["latest_turn"]["id"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        let row = view.data()["latest_turn"]["progress"]["safe_progress_rows"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|r| r["safe_tool_name"] == "generate_image" && r["tool_result_id"].is_string())
            .cloned();
        if let Some(row) = row {
            let call = row["tool_call_id"].as_str().unwrap();
            let result = row["tool_result_id"].as_str().unwrap();
            let path =
                format!("/turns/{turn}/operations/{call}/output?result_id={result}&offset=0");
            let page = f.s.gw.get(&path).await?;
            return Ok(page.data()["content"]
                .as_str()
                .unwrap_or_default()
                .to_owned());
        }
        assert!(
            Instant::now() < deadline,
            "no generate_image row in the child's activity\n{}",
            f.s.agent.logs()
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// The App's image card reads a successful image output with its asset id.
fn assert_image(content: &str) {
    let value: Value = serde_json::from_str(content).unwrap();
    let output = value.get("output").cloned().unwrap_or(value);
    assert_eq!(output["schema"], "butler.image.v1", "{output}");
    assert_eq!(output["status"], "ok", "{output}");
    assert!(
        output["image"]
            .as_str()
            .is_some_and(|id| id.starts_with("img_")),
        "{output}"
    );
}

#[tokio::test]
async fn steward_makes_an_image_and_its_activity_carries_it() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let f = Fixture::start(Access::FullAccess, "openai").await?;
    f.script(
        REQUEST,
        vec![call(
            "delegate",
            "delegate_to_steward",
            &json!({"request":REQUEST,"checks":["picture made"],"safe_title":"Picture"}),
        )],
    );
    f.script(
        "role: steward",
        vec![
            call(
                "plan",
                "replace_work_plan",
                &json!({"objective":REQUEST,"execution_mode":"direct","checks":["picture made"],
                    "actions":[{"action_key":"draw","description":REQUEST,"dependency_keys":[]}]}),
            ),
            call(
                "review",
                "record_work_review",
                &json!({"subject":"plan","verdict":"accept","summary":"Ready"}),
            ),
            generate("steward-gen"),
            call(
                "dispose",
                "record_work_disposition",
                &json!({"work_id":"{{WORK}}","disposition":"completed","summary":"Picture made.",
                    "action_updates":[{"action_key":"draw","status":"done"}],
                    "remaining_actions":[],"followups":[]}),
            ),
        ],
    );
    f.run(REQUEST).await?;
    let view = f.s.gw.get("/session-view?session_id=general").await?;
    let steward = view.data()["steward_children"][0]["session_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let content = child_image_output(&f, &steward).await?;
    let offered = f
        .script
        .requests
        .lock()
        .unwrap()
        .iter()
        .filter(|r| r.to_string().contains("role: steward"))
        .any(|r| functions(r).any(|t| t["name"] == "generate_image"));
    assert!(offered, "the steward is offered generate_image");
    assert_image(&content);
    f.finish().await
}

#[tokio::test]
async fn worker_makes_an_image_and_its_activity_carries_it() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let f = Fixture::start(Access::FullAccess, "openai").await?;
    let prompt = "Delegate drawing a kite to a worker";
    let accept = |id: &str| {
        call(
            id,
            "record_work_review",
            &json!({"subject":"plan","verdict":"accept","summary":"Ready"}),
        )
    };
    f.script(
        prompt,
        vec![call(
            "delegate",
            "delegate_to_steward",
            &json!({"request":"Draw a kite","checks":["picture made"],"safe_title":"Picture"}),
        )],
    );
    f.script(
        "role: steward",
        vec![
            call(
                "plan",
                "replace_work_plan",
                &json!({"objective":"Draw a kite","execution_mode":"workers","checks":["picture made"],
                    "actions":[{"action_key":"draw","description":"Draw a kite","dependency_keys":[]}]}),
            ),
            accept("review"),
            call(
                "delegate-worker",
                "delegate_to_worker",
                &json!({"task":{"scope":{"paths":["tasks/draw"]},"output":{"format":"text","fields":["summary"]}},
                    "action_key":"draw","objective":"Draw the kite",
                    "acceptance_criteria":["Checked"],"implementation_brief":"Generate the picture",
                    "safe_title":"draw"}),
            ),
            call("wait", "wait_for_worker", &json!({})),
        ],
    );
    f.script(
        "role: worker",
        vec![
            call(
                "worker-plan",
                "replace_work_plan",
                &json!({"objective":"Draw the kite","execution_mode":"direct","checks":["Checked"],
                    "actions":[{"action_key":"check","description":"Draw the kite","dependency_keys":[]}]}),
            ),
            accept("worker-review"),
            generate("worker-gen"),
            call(
                "worker-dispose",
                "record_work_disposition",
                &json!({"work_id":"{{WORK}}","disposition":"completed","summary":"Drawn",
                    "action_updates":[{"action_key":"check","status":"done"}],
                    "remaining_actions":[],"followups":[]}),
            ),
            json!({"type":"message","id":"worker-done","role":"assistant","status":"completed",
                "content":[{"type":"output_text","text":"Worker drew the kite.","annotations":[]}]}),
        ],
    );
    // A result Turn starts without a Work id; the first call's refusal reports the
    // steward's Work, which the second call closes.
    let close = |id: &str| {
        call(
            id,
            "record_work_disposition",
            &json!({"work_id":"{{WORK}}","disposition":"completed","summary":"Drawn",
                "action_updates":[{"action_key":"draw","status":"done"}],
                "remaining_actions":[],"followups":[]}),
        )
    };
    f.script(
        "Delegated result result_id: result-{{DIGEST}} task: worker-task-",
        vec![close("result-work"), close("result-done")],
    );
    f.run(prompt).await?;
    let view = f.s.gw.get("/session-view?session_id=general").await?;
    let steward = view.data()["steward_children"][0]["session_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let deadline = Instant::now() + Duration::from_secs(30);
    let worker = loop {
        let view =
            f.s.gw
                .get(&format!("/session-view?session_id={steward}"))
                .await?;
        if let Some(worker) = view.data()["workers"][0]["session_id"].as_str() {
            break worker.to_owned();
        }
        assert!(
            Instant::now() < deadline,
            "no worker started\n{}",
            f.s.agent.logs()
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    let content = child_image_output(&f, &worker).await?;
    let requests = f.script.requests.lock().unwrap().clone();
    let offered = requests
        .iter()
        .filter(|r| r.to_string().contains("role: worker"))
        .any(|r| functions(r).any(|t| t["name"] == "generate_image"));
    assert!(offered, "the worker is offered generate_image");
    assert_image(&content);
    f.finish().await
}
