use super::*;

#[tokio::test]
async fn rm_projection_bounds_titles_orders_and_counts_every_open_ask() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let (s, provider, server) = setup("RM-BOUNDS").await?;
    let mut ids = Vec::new();
    for n in 0..10 {
        ids.push(
            named_ask(&s, &provider, &format!("{n}:{}", "한".repeat(170))).await?["ask_id"].clone(),
        );
    }
    provider.requests.lock().unwrap().clear();
    s.turn("general", "What is the current status?").await?;
    let requests = provider.requests.lock().unwrap().clone();
    let projection = reminder(&requests[0]);
    let open = projection["open"].as_array().unwrap();
    assert_eq!(open.len(), 8);
    assert_eq!(projection["more"], 2);
    assert_eq!(asks(&s, "general").await?["open_count"], 10);
    for (ask, expected) in open.iter().zip(ids.iter().rev()) {
        assert_eq!(&ask["ask_id"], expected);
        assert_eq!(ask["title"].as_str().unwrap().chars().count(), 160);
    }
    // Open and settled entries share the same eight-entry volatile budget.
    provider.requests.lock().unwrap().clear();
    let reference = ids[0].as_str().unwrap().strip_prefix("question:").unwrap();
    let answered =
        s.gw.post(
            &format!("/authority-requests/{reference}/answer?session_id=general"),
            crate::ask_user::answer(),
        )
        .await?;
    assert_eq!(answered.status, 202, "{}", answered.text);
    super::guards::wait_delivered(&s, 12).await?;
    let requests = provider.requests.lock().unwrap().clone();
    let projection = reminder(requests.last().unwrap());
    assert_eq!(
        projection["open"].as_array().unwrap().len()
            + projection["settled"].as_array().unwrap().len(),
        8
    );
    assert_eq!(projection["more"], 2);
    assert_eq!(asks(&s, "general").await?["open_count"], 9);
    server.abort();
    s.finish().await
}
#[tokio::test]
async fn rm_card_settlement_is_visible_once_in_the_volatile_section() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, provider, server) = setup("RM-SETTLED").await?;
    let q = named_ask(&s, &provider, "Format").await?;
    let reference = q["ask_id"]
        .as_str()
        .unwrap()
        .strip_prefix("question:")
        .unwrap();
    let answer =
        s.gw.post(
            &format!("/authority-requests/{reference}/answer?session_id=general"),
            crate::ask_user::answer(),
        )
        .await?;
    assert_eq!(answer.status, 202, "{}", answer.text);
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let turns = s.gw.turns("general").await?;
            if turns.len() >= 2 && turns.iter().all(|t| turn_state(t) == "delivered") {
                return Ok::<_, HarnessError>(());
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .map_err(|e| HarnessError(e.to_string()))??;
    let requests = provider.requests.lock().unwrap().clone();
    let settled = requests
        .iter()
        .filter(|r| source(r).contains("## Open asks"))
        .map(reminder)
        .find(|p| p["settled"].as_array().is_some_and(|a| !a.is_empty()))
        .unwrap();
    assert_eq!(settled["open"], json!([]));
    assert_eq!(settled["settled"][0]["ask_id"], q["ask_id"]);
    assert_eq!(settled["settled"][0]["response"]["status"], "answered");
    provider.requests.lock().unwrap().clear();
    s.turn("general", "Continue after the answer.").await?;
    assert!(
        provider
            .requests
            .lock()
            .unwrap()
            .iter()
            .all(|r| !source(r).contains("## Open asks"))
    );
    server.abort();
    s.finish().await
}
