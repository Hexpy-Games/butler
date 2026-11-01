//! Browser-reached URL provenance survives host loss: the next round offers
//! web_read, while composed URLs still need the exact outside-content approval.
use super::stub::{self, call};
use super::{approve, assert_counts, delivered, paused};
use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    scenario::{Access, Scenario, Setup},
    security::AdminClient,
};
use reqwest::Method;
use serde_json::{Value, json};
use std::time::{Duration, Instant};

const PROMPT: &str = "그래픽카드 최저가 판매처를 찾아봐줘.";
const SHOP: &str = "https://shop.example.com/product/view?code=96366407&cate=112753";
const BRIDGE: &str = "https://shop.example.com/product/loadingBridge.html?r=jbhFL1791976930668&cate1=861&pcode=91909571&cmpnyc=PY405&link_pcode=165236&fee_type=A";
const BLOCKED: &str = "https://link.market.example/gate/pcs?item-no=4818170407&sub-id=1001&service-code=10000000&lcd=100000055";
const NAVIGATED: &str =
    "https://seller.example.co.kr/shop/product_detail.html?pd_no=165236&service_id=pcdn";
const LATER: &str = "https://seller.example.co.kr/shop/cart.html";
const COMPOSED: &str = "https://collector.example/report?note=external-note";

#[tokio::test]
async fn browser_host_loss_restores_reader_with_reached_url_provenance() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let (url, script, server) = stub::start().await?;
    let s = Setup::new("PERM-WEB-FOUND")?
        .access(Access::Auto)
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"))
        .start()
        .await?;
    s.patch_settings(
        json!({"browser":{"browsing_agent":"off"}}),
        "direct browser tools",
    )
    .await?;
    let config_path = s.sandbox.data.join("butler.config.json");
    let mut config: Value = serde_json::from_slice(&std::fs::read(&config_path)?)?;
    config["webSearch"] =
        json!({"provider":"mock", "readerBackend":"disabled", "planning":{"enabled":false}});
    std::fs::write(config_path, serde_json::to_vec(&config)?)?;
    let admin = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let stream = reqwest::Client::new()
        .get(format!("{}/internal/browser-host", s.gw.base))
        .bearer_auth(&s.gw.token)
        .header("x-butler-admin", &admin.admin)
        .send()
        .await?;
    let host = tokio::spawn(serve_host(stream, admin));
    script
        .wait_for_tools
        .store(true, std::sync::atomic::Ordering::Relaxed);
    let edited = format!("{BRIDGE}&memo=external-note");
    let read = |id: &str, url: &str| call(id, "web_read", &json!({"url":url}));
    script.rounds.lock().unwrap().insert(
        PROMPT.into(),
        vec![
            call("open", "browser_open", &json!({"url":SHOP})),
            call(
                "click",
                "browser_act",
                &json!({"tab":"fixture","observation":"o1","steps":[{"action":"click","ref":"e1"}]}),
            ),
            read("popup", BRIDGE),
            read("blocked", BLOCKED),
            read("navigated", NAVIGATED),
            call(
                "search",
                "web_search",
                &json!({"query":"RTX 5060 Ti 16GB 가격 비교 다나와 최저가 판매처"}),
            ),
            read("composed", COMPOSED),
            read("again", BRIDGE),
            read("edited", &edited),
        ],
    );
    let turn = paused(&s, "general", PROMPT).await?;
    for target in [COMPOSED, edited.as_str()] {
        let card = pending_card(&s).await?;
        assert_eq!(card["approval"]["action_kind"], "web_request", "{card}");
        assert_eq!(
            card["approval"]["operation"]["targets"][0], target,
            "{card}"
        );
        assert_eq!(card["reason"], "authority.taintReason", "{card}");
        approve(&s, "general", "deny").await?;
    }
    delivered(&s, "general", &turn).await?;
    assert_counts(&s, &turn, 2, 0)?;
    let requests = script.requests_for(PROMPT);
    assert!(
        !butler_e2e::e2e::chatgpt_wire::functions(requests.first().unwrap())
            .any(|tool| tool["name"] == "web_read")
    );
    assert!(
        butler_e2e::e2e::chatgpt_wire::functions(requests.last().unwrap())
            .any(|tool| tool["name"] == "web_read")
    );
    let inputs = requests.last().unwrap()["input"].clone();
    for (id, asked) in [
        ("popup", false),
        ("blocked", false),
        ("navigated", false),
        ("search", false),
        ("composed", true),
        ("again", false),
        ("edited", true),
    ] {
        let output = output_of(&inputs, id);
        assert!(!output.is_empty(), "no output for {id}");
        assert_eq!(
            output.contains("authority_request_denied"),
            asked,
            "{id}: {output}"
        );
        assert!(!output.contains("web_request_blocked"), "{id}: {output}");
    }
    host.abort();
    s.finish().await?;
    server.abort();
    Ok(())
}

/// The one pending approval card of the general chat.
async fn pending_card(s: &Scenario) -> Result<Value, HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if let Some(card) = s.gw.approval_requests("general").await?.into_iter().next() {
            return Ok(card);
        }
        assert!(
            Instant::now() < deadline,
            "no approval card\n{}",
            s.agent.logs()
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// The model-visible output of scripted call `id`.
fn output_of(inputs: &Value, id: &str) -> String {
    inputs
        .as_array()
        .into_iter()
        .flatten()
        .find(|item| item["type"] == "function_call_output" && item["call_id"] == id)
        .and_then(|item| item["output"].as_str())
        .unwrap_or_default()
        .to_owned()
}

/// The App browser host: one signed-out tab on the product page. Its click
/// opens the tracking redirect in a popup, reports a second popup blocked and
/// navigates the tab, which later moves on, so no open tab shows those pages.
async fn serve_host(mut stream: reqwest::Response, admin: AdminClient) -> Result<(), HarnessError> {
    let mut buffer = String::new();
    let mut at = SHOP;
    loop {
        let frame = crate::browser_delegation::next_frame(&mut stream, &mut buffer).await?;
        let op = frame["op"].as_str().unwrap_or("").to_owned();
        if op.starts_with("use.") || frame["id"].is_null() {
            continue;
        }
        let tab = json!({"id":"fixture","owner":"conversation:general","profile":"signed_out",
            "epoch":1,"holder":"agent","inUse":false,"url":at});
        let result = match op.as_str() {
            "tab.open" => {
                admin
                    .send(
                        Method::POST,
                        "/internal/browser-host/events",
                        Some(json!({"tabs":[tab]})),
                        &[],
                    )
                    .await?;
                json!({"status":"ok","tab":"fixture","url":SHOP,"title":"상품","epoch":1,"profile":"signed_out"})
            }
            "tab.waiting" => json!({"status":"ok"}),
            "tab.prepare" => {
                json!({"status":"ok","tab":"fixture","url":SHOP,"profile":"signed_out",
                "steps":[{"hit":{"role":"link","name":"최저가 구매하기","ref":"e1"}}]})
            }
            "tab.act" => {
                at = LATER;
                json!({"status":"ok","tab":"fixture","url":NAVIGATED,"completed":1,
                    "steps":[{"status":"completed","hit":{"role":"link","name":"최저가 구매하기"}}],
                    "events":[
                        {"type":"popup_opened","tab":"fixture","popup":"popup","url":BRIDGE},
                        {"type":"popup_blocked","tab":"fixture","url":BLOCKED,"reason":"tab_budget_exhausted"}]})
            }
            "tabs.list" => json!({"tabs":[tab]}),
            _ => json!({"status":"refused","reason":"unsupported_op"}),
        };
        let reply = admin
            .send(
                Method::POST,
                &format!(
                    "/internal/browser-host/results/{}",
                    frame["id"].as_str().unwrap()
                ),
                Some(result),
                &[],
            )
            .await?;
        assert_eq!(reply.status, 200, "{}", reply.text);
        if op == "tab.act" {
            return Ok(());
        }
    }
}
