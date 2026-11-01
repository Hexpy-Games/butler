//! Attached browser reads and sourced answer blocks on both provider wires.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
mod host;
mod model;

use butler_e2e::e2e::{
    HarnessError,
    config::ModelChoice,
    scenario::{Scenario, Setup},
    security::AdminClient,
};
use model::Wire;
use serde_json::{Value, json};

/// A public address literal: the reader's guard admits it without DNS.
const PAGE: &str = "https://93.184.216.34/desk-lamps";
const PROMPT: &str =
    "Which desk lamp on https://93.184.216.34/desk-lamps is the brightest? Compare them.";

#[tokio::test]
async fn attached_browser_reads_page_and_comparison_has_blocks_openai() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    flow(Wire::Codex).await
}

#[tokio::test]
async fn attached_browser_reads_page_and_comparison_has_blocks_anthropic()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    flow(Wire::Anthropic).await
}

async fn flow(wire: Wire) -> Result<(), HarnessError> {
    let fixture = model::Fixture::start(wire).await?;
    let s = start(wire, &fixture.base).await?;
    s.patch_settings(
        json!({"browser":{"browsing_agent":"off"}}),
        "direct browser tools",
    )
    .await?;
    let path = s.sandbox.data.join("butler.config.json");
    let mut config: Value = serde_json::from_slice(&std::fs::read(&path)?)?;
    config["webSearch"] = json!({"provider":"mock","readerBackend":"browser",
        "readerBackendRevision":2,"planning":{"enabled":false}});
    std::fs::write(path, serde_json::to_vec(&config)?)?;
    let admin = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let log = host::Log::default();
    let served = tokio::spawn(host::Host::attach(admin, log.clone()).await?.serve());
    let (id, turn) = s.turn("general", PROMPT).await?;
    served.abort();
    assert_eq!(turn["state"], "delivered", "{turn}\n{}", s.agent.logs());
    let outputs = fixture.outputs.lock().unwrap().clone();

    // The attached host is read directly through the offered browser tools.
    assert_eq!(outputs[0]["status"], "ok", "{}", outputs[0]);
    let read = &outputs[1];
    assert_eq!(read["schema"], "butler.browser-observation.v1", "{read}");
    let text = read["untrusted_content"]["text"].as_str().unwrap();
    for lamp in ["Aurora", "Beacon", "Cinder"] {
        assert!(text.contains(lamp), "{read}");
    }
    let ops = log
        .lock()
        .unwrap()
        .iter()
        .filter_map(|frame| frame["op"].as_str().map(str::to_owned))
        .filter(|op| op != "tabs.list")
        .collect::<Vec<_>>();
    assert_eq!(ops, ["tab.open", "tab.observe"], "{ops:?}");
    // (b) The comparison is on the delivered reply as blocks.
    assert_eq!(outputs[2]["ok"], true, "{}", outputs[2]);
    let messages = s.gw.messages("general").await?;
    let reply = messages
        .iter()
        .find(|m| m["role"] == "assistant" && m["turn_id"] == id && m["status"] == "delivered")
        .unwrap();
    let sets = reply["answer_blocks"].as_array().unwrap();
    assert_eq!(sets.len(), 1, "{reply}");
    let blocks = sets[0]["spec"]["blocks"].as_array().unwrap();
    assert_eq!(blocks[0]["items"].as_array().unwrap().len(), 3, "{reply}");
    assert_eq!(blocks[1]["type"], "table", "{reply}");

    // Each provider received the same guidance.
    let first = fixture.first.lock().unwrap().clone().unwrap();
    assert!(
        first["system"]
            .to_string()
            .contains("open_in_tab results in a browser_open tab"),
        "{}",
        first["system"]
    );
    let description = |name: &str| {
        butler_e2e::e2e::chatgpt_wire::tools(&first)
            .find(|tool| tool["name"] == name)
            .unwrap_or_else(|| panic!("{name} offered"))["description"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    assert!(!butler_e2e::e2e::chatgpt_wire::tools(&first).any(|tool| tool["name"] == "web_read"));
    assert!(description("answer_blocks").contains("with or without a Plan"));
    s.finish().await
}

async fn start(wire: Wire, base: &str) -> Result<Scenario, HarnessError> {
    match wire {
        Wire::Codex => {
            Setup::new("READER-TAB-OPENAI")?
                .env("BUTLER_CHATGPT_API_BASE_URL", format!("{base}/v1"))
                .start()
                .await
        }
        Wire::Anthropic => {
            let s = Setup::new("READER-TAB-ANTHROPIC")?
                .env("BUTLER_ANTHROPIC_BASE_URL", format!("{base}/v1"))
                .env("BUTLER_E2E_HOLD_MEMORY_BOOTSTRAP", "1")
                .start()
                .await?;
            let saved =
                s.gw.post(
                    "/credentials",
                    json!({"provider_id":"anthropic","api_key":"sk-ant-e2e-placeholder"}),
                )
                .await?;
            assert_eq!(saved.status, 201, "{}", saved.text);
            let registered =
                s.gw.post(
                    "/model-catalog/registered-models",
                    json!({
                "provider_id":"anthropic","model_id":"claude-sonnet-5","auth_type":"api_key",
                "credential_id":saved.data()["credential"]["id"]}),
                )
                .await?;
            assert_eq!(registered.status, 201, "{}", registered.text);
            let selected = s
                .select_model(&ModelChoice {
                    model: "anthropic/claude-sonnet-5".into(),
                    effort: None,
                })
                .await?;
            assert_eq!(selected.status, 200, "{}", selected.text);
            Ok(s)
        }
    }
}
