//! Web research reads search results without opening tabs, with an attached
//! App browser host and an offline search provider.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
mod availability;
pub(crate) mod host;
mod model;
mod resume;

use butler_e2e::e2e::{HarnessError, scenario::Setup, security::AdminClient};
use serde_json::{Value, json};
use std::time::Duration;

const PROMPT: &str =
    "What do the published tide tables say about spring tides? Compare the sources.";

#[tokio::test]
async fn research_reads_results_without_tabs() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let fixture = model::Fixture::start().await?;
    let setup = Setup::new("SEARCH-BROWSER")?
        .env(
            "BUTLER_CHATGPT_API_BASE_URL",
            format!("{}/v1", fixture.base),
        )
        .env("BUTLER_BRAVE_SEARCH_API_KEY", "offline-fixture-key");
    let s = setup.start().await?;
    super::outbound_http::logging(&s, "detailed").await?;
    s.patch_settings(
        json!({"browser":{"browsing_agent":"off"}}),
        "direct browser tools",
    )
    .await?;
    let path = s.sandbox.data.join("butler.config.json");
    let mut config: Value = serde_json::from_slice(&std::fs::read(&path)?)?;
    config["webSearch"] = json!({"provider":"brave","planning":{"enabled":false},
        "braveApiBase":format!("{}/search",fixture.base)});
    std::fs::write(path, serde_json::to_vec(&config)?)?;
    let admin = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let host = host::Host::attach(admin).await?;
    let log = host.log.clone();
    let served = tokio::spawn(host.serve());
    let turn = s.gw.say_turn("general", PROMPT).await?;
    let done =
        s.gw.wait_terminal("general", &turn, Duration::from_secs(60))
            .await?;
    assert_eq!(
        butler_e2e::e2e::gateway::turn_state(&done),
        "delivered",
        "{done}"
    );
    served.abort();
    let log = log.lock().unwrap().clone();
    let outputs = fixture.outputs.lock().unwrap().clone();

    let tools = fixture.tools.lock().unwrap().clone();
    for name in ["web_read", "browser_read"] {
        assert!(tools.iter().any(|tool| tool["name"] == name), "{tools:?}");
    }
    let open = tools
        .iter()
        .find(|tool| tool["name"] == "browser_open")
        .unwrap();
    assert!(open["parameters"]["properties"].get("results").is_none());
    assert!(outputs[0]["next"].as_str().unwrap().contains("web_read"));
    assert_eq!(
        log.iter().filter(|frame| frame["op"] == "tab.open").count(),
        0
    );
    for (read, name) in outputs[1..].iter().zip(["alpha", "beta", "gamma"]) {
        assert!(
            read["markdown"]
                .as_str()
                .unwrap()
                .contains(&host::page_text(&format!(
                    "https://example.com/tides/{name}"
                )))
        );
    }
    let messages = s.gw.messages("general").await?;
    let reply = messages
        .iter()
        .find(|message| {
            message["role"] == "assistant"
                && message["turn_id"] == turn
                && message["status"] == "delivered"
        })
        .unwrap();
    assert!(reply["text"].as_str().unwrap().contains("6.1 m"), "{reply}");
    s.finish().await
}
