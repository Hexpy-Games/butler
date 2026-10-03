use super::work_model::*;
use butler_e2e::e2e::{HarnessError, scenario::Scenario};
use serde_json::{Value, json};

async fn admit(s: &Scenario, key: &str, mode: &str, text: &str) -> Result<Value, HarnessError> {
    let reply =
        s.gw.post(
            "/sessions/general/instructions",
            json!({
                "idempotency_key":key,"mode":mode,"instruction":{"text":text}
            }),
        )
        .await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    Ok(reply.data().clone())
}

pub(super) async fn anchored_queue() -> Result<(), HarnessError> {
    let (mut s, turn) = setup("WM-02-18-10").await?;
    assert_eq!(apply(&s, light(&turn)).await?["ok"], true);
    let before = summary(&s).await?;
    let a = before["tasks"][0]["id"].clone();
    let request = |key: &str, command: Value| {
        json!({"instruction_id":turn,
        "idempotency_key":key,"expected_graph_revision":1,"command":command})
    };
    assert_eq!(
        apply(
            &s,
            request(
                "start",
                json!({"op":"start","task_id":a,"expected_revision":1})
            )
        )
        .await?["ok"],
        true
    );
    let queued = admit(
        &s,
        "after-a",
        "queue",
        "After that sort the remaining documents",
    )
    .await?;
    assert_eq!(queued["status"], "waiting_for_task", "{queued}");
    assert_eq!(queued["anchor"]["task_id"], a);
    assert_eq!(
        admit(
            &s,
            "after-a",
            "queue",
            "After that sort the remaining documents"
        )
        .await?,
        queued
    );
    assert_eq!(
        admit(&s, "after-a", "steer", "different").await?["error"]["code"],
        "idempotency_conflict"
    );
    let draft = summary(&s).await?;
    assert_eq!(draft["spec_count"], 1);
    assert_eq!(draft["total"], 4);
    assert_eq!(draft["counts"]["draft"], 1);
    assert_eq!(
        draft["tasks"][3]["origin_instruction_id"],
        queued["instruction_id"]
    );
    assert_eq!(
        draft["tasks"][3]["spec_ref"],
        before["tasks"][0]["spec_ref"]
    );
    assert_eq!(draft["tasks"][3]["criterion_ids"], json!([]));
    let steer = admit(&s, "question", "steer", "How many documents remain?").await?;
    assert_eq!(steer["mode"], "steer");
    let receipt = s.gw.get("/sessions/general/instructions").await?;
    assert_eq!(receipt.data()["instructions"][1]["mode"], "queue");
    s.restart().await?;
    let receipt = s.gw.get("/sessions/general/instructions").await?;
    assert_eq!(receipt.data()["instructions"][1]["anchor"]["task_id"], a);
    assert_eq!(summary(&s).await?["tasks"], draft["tasks"]);
    s.finish().await
}

pub(super) async fn long_queue() -> Result<(), HarnessError> {
    let (s, turn) = setup("WM-18-LONG-QUEUE").await?;
    assert_eq!(apply(&s, light(&turn)).await?["ok"], true);
    let before = summary(&s).await?;
    let a = before["tasks"][0]["id"].clone();
    assert_eq!(apply(&s,json!({"instruction_id":turn,"idempotency_key":"start","expected_graph_revision":1,"command":{"op":"start","task_id":a,"expected_revision":1}})).await?["ok"],true);
    for index in 0..60 {
        let receipt = admit(
            &s,
            &format!("held-{index}"),
            "queue",
            &format!("After A, requested item {index}"),
        )
        .await?;
        assert_eq!(receipt["status"], "waiting_for_task");
        assert_eq!(receipt["anchor"]["task_id"], a);
    }
    s.gw.patch("/settings", json!({"follow_up_behavior":"steer"}))
        .await?;
    let (_, result) = instruction_turn(&s, "Reply with exactly the word: once", None).await?;
    assert_eq!(result["state"], "delivered");
    let view = summary(&s).await?;
    assert_eq!(view["total"], 63);
    assert_eq!(view["counts"]["draft"], 60);
    assert_eq!(view["spec_count"], 1);
    assert_eq!(view["current_task_id"], a);
    assert_eq!(view["tasks"][0]["status"], "running");
    let mut cursor = 0;
    let mut receipts = Vec::new();
    loop {
        let page =
            s.gw.get(&format!("/sessions/general/instructions?after={cursor}"))
                .await?;
        let items = page.data()["instructions"].as_array().unwrap();
        if items.is_empty() {
            break;
        }
        assert!(items.len() <= 50);
        receipts.extend(items.clone());
        cursor = page.data()["next_cursor"].as_u64().unwrap();
    }
    assert_eq!(receipts.len(), 62);
    for receipt in &receipts[1..61] {
        assert_eq!(receipt["mode"], "queue");
        assert_eq!(receipt["status"], "waiting_for_task");
        assert_eq!(receipt["anchor"]["task_id"], a);
    }
    assert_eq!(receipts[61]["mode"], "steer");
    assert_eq!(receipts[61]["status"], "applied");
    assert_eq!(s.provider()?.served(), 2);
    assert_eq!(s.gw.turns("general").await?.len(), 2);
    s.finish().await
}
