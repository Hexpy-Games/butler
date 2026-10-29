//! Run separately once after functional checks; assert complete content alongside timings.
use super::*;
use std::time::{Duration, Instant};

#[tokio::test]
async fn document_request_measurements() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut cassette = butler_e2e::e2e::cassette::Cassette::load("TOOL-01")?;
    let mut exchange = cassette.exchanges[0].clone();
    exchange.request.key.user_request = "Review the documents.".into();
    exchange.request.key.round.clear();
    exchange.response = crate::browser_usage::stub::response(
        &json!({"type":"message","id":"measurement","role":"assistant","status":"completed","content":[{"type":"output_text","text":"Reviewed.","annotations":[]}]}),
    );
    cassette.exchanges = vec![exchange];
    let s = Setup::new("DOCUMENT-REQUEST-MEASUREMENTS")?
        .stub_cassette(cassette)
        .start()
        .await?;
    let large = "x".repeat(256 * 1024);
    let mut ids = Vec::new();
    for index in 0..20 {
        let doc = ok(s.gw.post("/documents", json!({"title":format!("Report {index}"),"body":"Before","author":"butler","chat_id":"general"})).await?);
        let id = doc["id"].as_str().unwrap().to_owned();
        ok(s.gw
            .post(
                &format!("/documents/{id}/seen"),
                json!({"chat_id":"general","rev":1}),
            )
            .await?);
        let body = if index == 0 {
            large.clone()
        } else {
            format!("Updated report {index}")
        };
        let start = Instant::now();
        let saved = put(&s, &id, 1, &body, "user").await?;
        let elapsed = start.elapsed();
        assert_eq!(saved["rev"], 2);
        let head = ok(s.gw.get(&format!("/documents/{id}")).await?);
        assert_eq!(head["body"], body);
        if index == 0 {
            eprintln!(
                "PUT /documents/{{id}} 262144 bytes: {:.3} ms",
                elapsed.as_secs_f64() * 1000.0
            );
        }
        ids.push(id);
    }
    let start = Instant::now();
    let accepted = s.gw.say("general", "Review the documents.").await?;
    let elapsed = start.elapsed();
    eprintln!(
        "POST /messages admission with 20 edited documents: {:.3} ms",
        elapsed.as_secs_f64() * 1000.0
    );
    let turn_id = s.gw.accepted_turn(&accepted).await?;
    let turn =
        s.gw.wait_terminal("general", &turn_id, Duration::from_secs(60))
            .await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    let requests = s.provider()?.requests();
    let request = requests
        .iter()
        .find(|request| {
            request
                .to_string()
                .contains("Documents the user edited since you last saw them.")
        })
        .unwrap()
        .to_string();
    for id in ids {
        assert!(
            request.contains(&id),
            "all 20 document edits reach the model"
        );
    }
    s.finish().await
}
