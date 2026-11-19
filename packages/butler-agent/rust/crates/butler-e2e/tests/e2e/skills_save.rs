//! Saved user skills are loadable within the same conversation turn.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "E2E assertions")]
#[path = "skills_cleanup/stub.rs"]
mod stub;
use butler_e2e::e2e::{HarnessError, cassette::Cassette, scenario::Setup};
use serde_json::json;

const PROMPT: &str = "Turn the product search rule into a skill.";

fn cassette() -> Result<Cassette, HarnessError> {
    let template = Cassette::load("SKILL-222")?;
    let mut cassette = Cassette::load("SKILL-222")?;
    cassette.exchanges.clear();
    let responses = [
        json!({"type":"function_call","id":"fc_save","call_id":"call_save","name":"save_skill","status":"completed","arguments":json!({"name":"product-search","description":"Search products across markets","applicability":"When the user asks to find or compare a product","instructions":"PRODUCT_SEARCH_BODY"}).to_string()}),
        json!({"type":"function_call","id":"fc_load","call_id":"call_load","name":"load_skill","status":"completed","arguments":json!({"name":"product-search"}).to_string()}),
        json!({"type":"message","id":"msg_saved","role":"assistant","status":"completed","content":[{"type":"output_text","text":"Saved.","annotations":[]}]}),
    ];
    for (round, response) in responses.iter().enumerate() {
        let mut exchange = template.exchanges[round].clone();
        exchange.request.key.user_request = PROMPT.to_owned();
        exchange.response = stub::response(response);
        cassette.exchanges.push(exchange);
    }
    Ok(cassette)
}

// test-category: e2e
#[tokio::test]
async fn saves_user_skill_and_loads_it_in_the_same_turn() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("SKILLS-SAVE")?
        .stub_cassette(cassette()?)
        .replay_only()
        .start()
        .await?;
    let (_, turn) = s.turn("general", PROMPT).await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    assert!(
        s.sandbox
            .data
            .join("skills/default/product-search/SKILL.md")
            .exists()
    );
    let requests = s.provider()?.requests();
    assert!(requests[1]["input"].as_array().unwrap().iter().any(|item| {
        item["output"]
            .as_str()
            .is_some_and(|output| output.contains("\"ok\":true"))
    }));
    assert!(
        requests[2]["input"]
            .to_string()
            .contains("PRODUCT_SEARCH_BODY")
    );
    s.finish().await
}
