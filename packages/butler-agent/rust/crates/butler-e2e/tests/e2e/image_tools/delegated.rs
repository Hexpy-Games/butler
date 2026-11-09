use super::*;
use butler_e2e::e2e::chatgpt_wire::functions;
use std::time::{Duration, Instant};

const REQUEST: &str = "Make a picture of a kite";

#[tokio::test]
async fn steward_makes_an_image_and_its_id_reaches_the_parent() -> Result<(), HarnessError> {
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
    let deadline = Instant::now() + Duration::from_secs(30);
    let relayed = loop {
        let relayed = f.script.requests.lock().unwrap().iter().find_map(|r| {
            let text = r.to_string();
            (text.contains("Delegated result") && text.contains("image_assets:")).then_some(text)
        });
        if let Some(text) = relayed {
            break text;
        }
        assert!(
            Instant::now() < deadline,
            "no image ids reached the parent\n{}",
            f.s.agent.logs()
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    let offered = f
        .script
        .requests
        .lock()
        .unwrap()
        .iter()
        .filter(|r| r.to_string().contains("role: steward"))
        .any(|r| functions(r).any(|t| t["name"] == "generate_image"));
    assert!(offered, "the steward is offered generate_image");
    let output = f.output("steward-gen");
    assert_eq!(output["status"], "ok", "{output}");
    let image = output["image"].as_str().unwrap();
    assert!(
        relayed.contains(image),
        "the made image's id reaches the parent"
    );
    f.finish().await
}

#[tokio::test]
async fn worker_makes_an_image_and_its_id_reaches_steward_and_butler() -> Result<(), HarnessError> {
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
    let deadline = Instant::now() + Duration::from_secs(60);
    let butler = loop {
        let found = f.script.requests.lock().unwrap().iter().find_map(|r| {
            let text = r.to_string();
            (text.contains("image_assets:")
                && !text.contains("role: steward")
                && !text.contains("role: worker"))
            .then_some(text)
        });
        if let Some(text) = found {
            break text;
        }
        assert!(
            Instant::now() < deadline,
            "no image ids reached the Butler\n{}",
            f.s.agent.logs()
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    let requests = f.script.requests.lock().unwrap().clone();
    let offered = requests
        .iter()
        .filter(|r| r.to_string().contains("role: worker"))
        .any(|r| functions(r).any(|t| t["name"] == "generate_image"));
    assert!(offered, "the worker is offered generate_image");
    let output = f.output("worker-gen");
    assert_eq!(output["status"], "ok", "{output}");
    let image = output["image"].as_str().unwrap();
    assert!(
        requests.iter().any(|r| {
            let text = r.to_string();
            text.contains("image_assets:") && text.contains("role: steward") && text.contains(image)
        }),
        "the worker's image id reaches the steward"
    );
    assert!(
        butler.contains(image),
        "the worker's image id reaches the Butler"
    );
    f.finish().await
}
