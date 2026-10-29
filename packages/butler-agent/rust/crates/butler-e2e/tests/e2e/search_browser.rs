//! Web research through Butler's browser: a general request that never says
//! "browser" searches, opens the results as background tabs in parallel,
//! reads them from those tabs and answers. A scripted model, an offline
//! search fixture and this test as the App browser host; no network.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
pub(crate) mod host;
mod model;
mod resume;

use butler_e2e::e2e::{HarnessError, scenario::Setup, security::AdminClient};
use serde_json::{Value, json};
use std::time::Duration;

const PROMPT: &str =
    "What do the published tide tables say about spring tides? Compare the sources.";

#[tokio::test]
async fn research_searches_opens_results_as_tabs_and_reads_them() -> Result<(), HarnessError> {
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
    let parallel_opens = host.parallel_opens.clone();
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

    // The model saw one coherent toolset without asking for a browser.
    let tools = fixture.tools.lock().unwrap().clone();
    for name in [
        "web_search",
        "web_read",
        "browser_open",
        "browser_observe",
        "browser_act",
    ] {
        assert!(
            tools.iter().any(|t| t["name"] == name),
            "{name} offered: {tools:?}"
        );
    }
    for index in [0, 2, 3] {
        for key in [
            "evidence_receipts",
            "evidence_capability_receipts",
            "public_web_evidence_items",
        ] {
            assert!(
                outputs[index].get(key).is_none(),
                "{key}: {}",
                outputs[index]
            );
        }
    }
    let search = &outputs[0];
    let ids = search["results"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["id"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    assert_eq!(ids, ["r1", "r2", "r3"], "{search}");

    // All three opens reached the browser before any was answered.
    let opened = &outputs[1];
    assert_eq!(opened["status"], "ok", "{opened}");
    assert_eq!(opened["tabs"].as_array().unwrap().len(), 3, "{opened}");
    assert_eq!(
        parallel_opens.load(std::sync::atomic::Ordering::SeqCst),
        3,
        "{log:?}"
    );
    for (tab, id) in opened["tabs"].as_array().unwrap().iter().zip(&ids) {
        assert_eq!(tab["result"], id.as_str(), "{opened}");
        assert_eq!(tab["status"], "ok", "{opened}");
    }
    assert!(
        log.iter()
            .filter(|f| f["op"] == "tab.open")
            .all(|f| f["args"]["background"] == true),
        "{log:?}"
    );

    // web_read used the open tab's live document, read again for the
    // continuation: a page can change without navigating.
    let read = &outputs[2];
    assert_eq!(read["reader"], "butler-browser-tab", "{read}");
    assert!(
        read["markdown"]
            .as_str()
            .unwrap()
            .contains("Spring tides alpha"),
        "{read}"
    );
    let again = &outputs[3];
    assert_eq!(again["reader"], "butler-browser-tab", "{again}");
    assert_eq!(again["cache_hit"], false, "{again}");
    assert_eq!(again["content_sha256"], read["content_sha256"], "{again}");
    // A long page keeps all its text: the continuation reaches the end.
    assert!(read["total_chunks"].as_u64().unwrap() >= 3, "{read}");
    assert_eq!(again["content_has_more"], false, "{again}");
    assert!(
        again["markdown"]
            .as_str()
            .unwrap()
            .contains("End of the tide table."),
        "{again}"
    );
    assert_eq!(
        log.iter().filter(|f| f["op"] == "tab.read").count(),
        2,
        "{log:?}"
    );

    // The observation is text and refs; no screenshot was asked for or returned.
    let observe = log.iter().find(|f| f["op"] == "tab.observe").unwrap();
    assert_ne!(observe["args"]["include_image"], true, "{observe}");
    let observed = &outputs[4];
    assert_eq!(
        observed["schema"], "butler.browser-observation.v1",
        "{observed}"
    );
    assert!(observed.get("image").is_none(), "{observed}");
    assert!(
        observed["untrusted_content"]["text"]
            .as_str()
            .unwrap()
            .contains("Spring tides alpha")
    );
    eprintln!(
        "{}",
        model::step_bytes(
            &s.sandbox.data,
            &turn,
            &outputs,
            &fixture.output_bytes.lock().unwrap()
        )
    );
    if let Some(dir) = std::env::var_os("BUTLER_SEARCH_BROWSER_EVIDENCE") {
        std::fs::write(
            std::path::Path::new(&dir).join("model-tools.json"),
            serde_json::to_vec_pretty(&tools)?,
        )?;
    }
    let requests =
        super::outbound_http::http_calls(&s, &format!("{}/search", fixture.base)).await?;
    assert_eq!(
        requests.len(),
        1,
        "one record for the single search request"
    );
    s.finish().await
}
