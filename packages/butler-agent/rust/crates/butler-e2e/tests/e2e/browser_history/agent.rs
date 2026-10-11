//! Discover and execute the general read-only history tool via a stub model.
use super::{items, visit};
use butler_e2e::e2e::{
    HarnessError, cassette::Cassette, gateway::turn_state, scenario::Setup, security::AdminClient,
};
use reqwest::Method;
use serde_json::{Value, json};
const ASK: &str = "Find the page I visited yesterday.";
fn cassette() -> Result<Cassette, HarnessError> {
    let template = Cassette::load("TOOL-01")?;
    let mut cassette = Cassette::load("TOOL-01")?;
    cassette.exchanges.clear();
    let calls = [
        (
            "tool_search",
            json!({"query":"browser history visited search","limit":10}),
        ),
        (
            "tool_describe",
            json!({"ids":["native:browser_history_search"]}),
        ),
        (
            "tool_call",
            json!({"id":"native:browser_history_search","arguments":{"query":"recipe","since":"2026-10-10T00:00:00Z","until":"2026-10-10T23:59:59Z"}}),
        ),
    ];
    let mut round = Vec::new();
    for (index, (name, args)) in calls.into_iter().enumerate() {
        let mut exchange = template.exchanges[0].clone();
        exchange.request.key.user_request = ASK.into();
        exchange.request.key.round = round.clone();
        exchange.response = super::super::browser_usage::stub::response(
            &json!({"type":"function_call","id":format!("fc_history_{index}"),"call_id":format!("call_history_{index}"),"name":name,"arguments":args.to_string(),"status":"completed"}),
        );
        cassette.exchanges.push(exchange);
        round.extend(["function_call".into(), "function_call_output".into()]);
    }
    let mut last = template.exchanges[1].clone();
    last.request.key.user_request = ASK.into();
    last.request.key.round = round;
    last.response = super::super::browser_usage::stub::response(
        &json!({"type":"message","id":"history_result","role":"assistant","status":"completed","content":[{"type":"output_text","text":"Found.","annotations":[]}]}),
    );
    cassette.exchanges.push(last);
    Ok(cassette)
}
#[tokio::test]
async fn agent_history_search_returns_current_visits_after_deletion() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("BROWSER-HISTORY-AGENT")?
        .stub_cassette(cassette()?)
        .start()
        .await?;
    let admin = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let rows = [
        visit(
            "https://example.com/kept",
            "2026-10-10T01:00:00Z",
            "Recipe kept",
        ),
        visit(
            "https://example.com/deleted",
            "2026-10-10T02:00:00Z",
            "Recipe deleted",
        ),
    ];
    assert_eq!(
        admin
            .send(
                Method::POST,
                "/internal/browser-host/visits",
                Some(json!({"visits":rows})),
                &[]
            )
            .await?
            .status,
        200
    );
    let page = items(&s, "/browser-history").await?;
    let deleted = page["items"][0]["id"].clone();
    assert_eq!(
        s.gw.post("/browser-history/delete", json!({"ids":[deleted]}))
            .await?
            .status,
        200
    );
    let (_, turn) = s.turn("general", ASK).await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    let requests = s.provider()?.requests();
    let last = requests.last().unwrap();
    let outputs: Vec<Value> = last["input"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|i| i["type"] == "function_call_output")
        .map(|i| serde_json::from_str::<Value>(i["output"].as_str().unwrap()).unwrap())
        .collect();
    let found = outputs.last().unwrap();
    let found = found.get("output").unwrap_or(found);
    let visits = &found["untrusted_content"]["data"]["items"];
    assert_eq!(visits.as_array().unwrap().len(), 1, "{found}");
    assert_eq!(visits[0]["url"], "https://example.com/kept");
    s.finish().await
}
