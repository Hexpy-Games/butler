//! The agent files and tags saved items when asked: a stub model finds them
//! with `library_search`, files them with `library_organize`, and a mixed-kind
//! call comes back as an error the model can act on. The App shows the result.
use super::{ok, page, scrap};
use butler_e2e::e2e::{HarnessError, cassette::Cassette, gateway::turn_state, scenario::Setup};
use serde_json::{Value, json};

const ASK: &str = "이 스크랩들 여행 그룹에 넣고 일본 태그 달아줘";

fn cassette(bookmark: &str) -> Result<Cassette, HarnessError> {
    let template = Cassette::load("TOOL-01")?;
    let mut cassette = Cassette::load("TOOL-01")?;
    cassette.exchanges.clear();
    let calls = [
        (
            "tool_search",
            json!({"query":"library organize tag group","limit":10}),
        ),
        (
            "tool_describe",
            json!({"ids":["native:library_search","native:library_organize"]}),
        ),
        (
            "tool_call",
            json!({"id":"native:library_search","arguments":{"query":"kyoto","kind":"scrap"}}),
        ),
        (
            "tool_call",
            json!({"id":"native:library_organize","arguments":{"ids":["k1",bookmark],"group":"여행"}}),
        ),
        (
            "tool_call",
            json!({"id":"native:library_organize","arguments":{"ids":["k1","o1"],"group":"여행","add_tags":["일본"]}}),
        ),
    ];
    let mut round = Vec::new();
    for (index, (name, args)) in calls.into_iter().enumerate() {
        let mut exchange = template.exchanges[0].clone();
        exchange.request.key.user_request = ASK.into();
        exchange.request.key.round = round.clone();
        exchange.response = super::super::browser_usage::stub::response(
            &json!({"type":"function_call","id":format!("fc_library_{index}"),"call_id":format!("call_library_{index}"),"name":name,"arguments":args.to_string(),"status":"completed"}),
        );
        cassette.exchanges.push(exchange);
        round.extend(["function_call".into(), "function_call_output".into()]);
    }
    let mut last = template.exchanges[1].clone();
    last.request.key.user_request = ASK.into();
    last.request.key.round = round;
    last.response = super::super::browser_usage::stub::response(
        &json!({"type":"message","id":"msg_library","role":"assistant","status":"completed","content":[{"type":"output_text","text":"Filed.","annotations":[]}]}),
    );
    cassette.exchanges.push(last);
    Ok(cassette)
}

/// The tool outputs the model received, in order.
fn outputs(requests: &[Value]) -> Vec<Value> {
    let last = requests.last().unwrap();
    last["input"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| item["type"] == "function_call_output")
        .map(|item| {
            let result: Value = serde_json::from_str(item["output"].as_str().unwrap()).unwrap();
            result.get("output").cloned().unwrap_or(result)
        })
        .collect()
}

#[tokio::test]
async fn agent_searches_then_files_and_tags_library_items() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let url = "https://docs.example.com/";
    let bookmark = {
        use sha2::{Digest, Sha256};
        format!("bookmark-{:x}", Sha256::digest(url.as_bytes()))
    };
    let s = Setup::new("BROWSER-LIBRARY-AGENT")?
        .stub_cassette(cassette(&bookmark)?)
        .start()
        .await?;
    for (id, title) in [
        ("k1", "Kyoto temples"),
        ("o1", "Osaka food"),
        ("t1", "Tax form"),
    ] {
        ok(s.gw.post("/library", scrap(id, title)).await?);
    }
    ok(s.gw.post("/library", json!({"id":"x","kind":"bookmark","title":"Docs","url":url,"capturedAt":"2026-10-09T00:00:00Z"})).await?);
    let (_, turn) = s.turn("general", ASK).await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}\n{}", s.agent.logs());

    let results = outputs(&s.provider()?.requests());
    assert_eq!(results.len(), 5, "{results:?}");
    let found = &results[2];
    let found_ids = found["items"]
        .as_array()
        .unwrap_or_else(|| panic!("{found}"))
        .iter()
        .map(|i| i["id"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(found_ids, ["k1"], "{found}");
    assert_eq!(found["items"][0]["kind"], "scrap");
    assert_eq!(
        results[3]["error"]["code"], "library_group_kind_mismatch",
        "{}",
        results[3]
    );
    assert!(
        results[3]["error"]["message"]
            .as_str()
            .unwrap()
            .contains("once per kind")
    );
    let filed = &results[4];
    assert_eq!(
        (
            filed["ok"].as_bool(),
            filed["group"]["name"].as_str(),
            filed["group"]["created"].as_bool()
        ),
        (Some(true), Some("여행"), Some(true)),
        "{filed}"
    );
    assert_eq!(filed["items"][0]["group"], "여행");
    assert_eq!(filed["items"][0]["tags"], json!(["일본"]));

    let groups = page(&s, "/library/groups?kind=scrap").await?;
    assert_eq!(groups["groups"][0]["name"], "여행");
    assert_eq!(groups["groups"][0]["count"], 2);
    assert_eq!(
        groups["ungrouped"], 1,
        "the failed mixed-kind call changed nothing"
    );
    let tagged = page(&s, "/library?kind=scrap&tags=일본").await?;
    assert_eq!(tagged["items"].as_array().unwrap().len(), 2);
    assert_eq!(
        page(&s, "/library?kind=bookmark").await?["items"][0]["group"],
        Value::Null
    );
    s.finish().await
}
