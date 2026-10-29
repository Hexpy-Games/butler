use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    gateway::turn_state,
    scenario::{Scenario, accepted_turn_id},
};
use serde_json::{Value, json};
use std::time::Duration;

pub(super) const ASK: &str = "Use the account page";

pub(super) fn cassette(calls: Vec<(&str, Value)>) -> Result<Cassette, HarnessError> {
    let template = Cassette::load("TOOL-01")?;
    let mut cassette = Cassette::load("TOOL-01")?;
    cassette.exchanges.clear();
    let mut round = Vec::new();
    for (index, (name, args)) in calls.into_iter().enumerate() {
        let mut exchange = template.exchanges[0].clone();
        exchange.request.key.user_request = ASK.into();
        exchange.request.key.round = round.clone();
        exchange.response = crate::browser_usage::stub::response(&json!({"type":"function_call",
            "id":format!("fc_always_{index}"),"call_id":format!("call_always_{index}"),
            "name":name,"arguments":args.to_string(),"status":"completed"}));
        cassette.exchanges.push(exchange);
        round.extend(["function_call".into(), "function_call_output".into()]);
    }
    let mut last = template.exchanges[1].clone();
    last.request.key.user_request = ASK.into();
    last.request.key.round = round;
    last.response = crate::browser_usage::stub::response(
        &json!({"type":"message","id":"msg_always",
        "role":"assistant","status":"completed","content":[{"type":"output_text","text":"Done.","annotations":[]}]}),
    );
    cassette.exchanges.push(last);
    Ok(cassette)
}

pub(super) async fn begin(s: &Scenario, session: &str) -> Result<String, HarnessError> {
    accepted_turn_id(&s.gw.say(session, ASK).await?)
}

pub(super) async fn delivered(s: &Scenario, session: &str, id: &str) -> Result<(), HarnessError> {
    let done =
        s.gw.wait_terminal(session, id, Duration::from_secs(30))
            .await?;
    assert_eq!(turn_state(&done), "delivered", "{done}\n{}", s.agent.logs());
    assert_eq!(s.gw.approval_requests(session).await?, Vec::<Value>::new());
    Ok(())
}

pub(super) async fn decide(
    s: &Scenario,
    session: &str,
    card: &Value,
    scope: &str,
) -> Result<(), HarnessError> {
    let reference = card["request_ref"].as_str().unwrap();
    let response =
        s.gw.post(
            &format!("/authority-requests/{reference}/allow?session_id={session}"),
            json!({"scope":scope}),
        )
        .await?;
    assert_eq!(response.status, 202, "{}", response.text);
    Ok(())
}

pub(super) async fn session(s: &Scenario) -> Result<String, HarnessError> {
    let created =
        s.gw.post("/sessions", json!({"kind":"chat","title":"Another chat"}))
            .await?;
    Ok(created.data()["session"]["id"].as_str().unwrap().to_owned())
}
