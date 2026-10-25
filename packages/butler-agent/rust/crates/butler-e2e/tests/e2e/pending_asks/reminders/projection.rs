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
    assert!(projection.to_string().len() <= 1600, "{projection}");
    let open = projection["open"].as_array().unwrap();
    assert_eq!(open.len(), 8);
    assert_eq!(projection["more"], 2);
    assert_eq!(projection["settled_more"], Value::Null);
    assert_eq!(asks(&s, "general").await?["open_count"], 10);
    for (ask, expected) in open.iter().zip(ids.iter().rev()) {
        assert_eq!(&ask["ask_id"], expected);
        let title = ask["title"].as_str().unwrap();
        assert!(!title.is_empty() && title.chars().count() < 160);
        assert!(title.ends_with('…'));
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
    assert_eq!(projection["open"].as_array().unwrap().len(), 8);
    for (ask, expected) in projection["open"]
        .as_array()
        .unwrap()
        .iter()
        .zip(ids.iter().rev())
    {
        assert_eq!(&ask["ask_id"], expected);
    }
    assert_eq!(projection["more"], 1);
    assert_eq!(projection["settled_more"], 1);
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
    let long_answer = "답".repeat(3000);
    let answer =
        s.gw.post(
            &format!("/authority-requests/{reference}/answer?session_id=general"),
            json!({"status":"answered","answers":[{"id":"format","selected":[],
                "custom":long_answer,"skipped":false}]}),
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
    let summary = settled["settled"][0]["response"]["answer"]
        .as_str()
        .unwrap();
    assert_eq!(summary.chars().count(), 160);
    assert!(summary.ends_with('…'));
    let section = source(requests.last().unwrap())
        .split("## Open asks")
        .nth(1)
        .unwrap()
        .split("## Current request")
        .next()
        .unwrap();
    assert!(
        section.len() <= 1600,
        "settled section: {} bytes",
        section.len()
    );
    eprintln!(
        "RM-SETTLED section_bytes={} answer_chars={} summary_chars={}",
        section.len(),
        long_answer.chars().count(),
        summary.chars().count()
    );
    let view = s.gw.get("/session-view?session_id=general").await?;
    assert_eq!(
        view.data()["question_answers"][0]["response"]["answers"][0]["custom"],
        long_answer
    );
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

#[tokio::test]
async fn rm_eight_open_and_eight_settled_korean_entries_fit_json_budget() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let (mut s, provider, server) = setup("RM-EIGHT-EACH").await?;
    let mut ids = Vec::new();
    for index in 0..16 {
        let title = format!("{index}:{}", "한".repeat(170));
        ids.push(named_ask(&s, &provider, &title).await?["ask_id"].clone());
    }
    // Seed eight already-settled receipts together between process lifetimes,
    // so no intervening follow-up reply consumes their reminder window.
    s.agent.terminate().await?;
    let data = s.sandbox.data.clone();
    let settled_ids = ids[..8].to_vec();
    tokio::task::spawn_blocking(move || -> Result<(), HarnessError> {
        let mut db = butler_platform::sqlite::open(data.join("agent-runtime/btcc.sqlite"))?;
        let transaction = db.transaction()?;
        let receipt = json!({"status":"answered","answers":[{"id":"format","selected":[],
            "custom":"답".repeat(3000),"skipped":false}]})
        .to_string();
        for id in settled_ids {
            let reference = id.as_str().unwrap().strip_prefix("question:").unwrap();
            assert_eq!(
                transaction.execute(
                    "UPDATE btcc_authority_requests SET outcome_receipt_json=?1,
                 updated_at='2099-01-01T00:00:00.000Z' WHERE request_ref=?2",
                    rusqlite::params![receipt, reference],
                )?,
                1
            );
        }
        transaction.commit()?;
        Ok(())
    })
    .await
    .map_err(|error| HarnessError(error.to_string()))??;
    s.restart().await?;
    provider.requests.lock().unwrap().clear();
    let (_, turn) = s.turn("general", "Show all current choices.").await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    let requests = provider.requests.lock().unwrap().clone();
    let projection = reminder(&requests[0]);
    let raw = source(&requests[0])
        .split("## Open asks")
        .nth(1)
        .unwrap()
        .lines()
        .find(|line| line.starts_with('{'))
        .unwrap();
    assert!(raw.len() <= 1600, "JSON bytes={}: {raw}", raw.len());
    let open = projection["open"].as_array().unwrap();
    assert_eq!(open.len(), 8);
    assert_eq!(projection["more"], 0);
    assert_eq!(projection["settled"], json!([]));
    assert_eq!(projection["settled_more"], 8);
    for (entry, expected) in open.iter().zip(ids[8..].iter().rev()) {
        assert_eq!(&entry["ask_id"], expected);
        let title = entry["title"].as_str().unwrap();
        assert!(!title.is_empty() && title.chars().count() < 160);
        assert!(title.ends_with('…'));
    }
    assert_eq!(asks(&s, "general").await?["open_count"], 8);
    let view = s.gw.get("/session-view?session_id=general").await?;
    let answers = view.data()["question_answers"].as_array().unwrap();
    assert_eq!(answers.len(), 16);
    let settled = answers
        .iter()
        .filter(|answer| answer["response"]["status"] == "answered")
        .collect::<Vec<_>>();
    assert_eq!(settled.len(), 8);
    assert!(
        settled
            .iter()
            .all(|answer| answer["response"]["answers"][0]["custom"] == "답".repeat(3000))
    );
    eprintln!(
        "RM-EIGHT-EACH json_bytes={} open=8 more=0 settled_more=8",
        raw.len()
    );
    server.abort();
    s.finish().await
}
