use super::{
    fixture::Task,
    live_proxy::{Proxy, Spend},
};
use butler_e2e::e2e::{
    HarnessError,
    scenario::{Scenario, Setup},
    security::AdminClient,
};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

async fn setup() -> Result<
    (
        Scenario,
        Proxy,
        butler_platform::app_browser::AppHostProcess,
    ),
    HarnessError,
> {
    let s = Setup::new("RESEARCH-SNAPSHOT-LIFECYCLE")?
        .stub_cassette(butler_e2e::e2e::cassette::Cassette::load("TOOL-01")?)
        .start()
        .await?;
    s.provider()?
        .set_chat_responder(crate::briefing_effort::briefing);
    let task = Arc::new(Task {
        spec: json!({"facts":[]}),
        pages: [("https://example.com/one".into(), ("First".into(), "<!doctype html><title>First</title><h1>First snapshot</h1><a href='/two'>Next</a><a href='https://missing.example/absent'>Missing</a>".into())),
            ("https://example.com/two".into(), ("Second".into(), "<!doctype html><title>Second</title><h1>Second snapshot</h1>".into()))].into(),
    });
    let proxy = Proxy::with_upstream(
        "http://127.0.0.1:9".into(),
        task.clone(),
        Arc::new(Mutex::new(Spend {
            max: 1.0,
            ..Default::default()
        })),
        "arbitrary",
    )
    .await?;
    let browser = super::live_browser::start(&s, &task, &proxy).await?;
    Ok((s, proxy, browser))
}
async fn call(s: &Scenario, op: &str, tab: &Value, args: Value) -> Result<Value, HarnessError> {
    let admin = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let reply = admin
        .send(
            reqwest::Method::POST,
            "/internal/browser/calls",
            Some(json!({"session":"general","op":op,"tab":tab,"args":args})),
            &[],
        )
        .await?;
    assert_eq!(reply.status, 200, "{op}: {}", reply.text);
    if reply.body["reason"] == "executor_error" {
        let log = tokio::fs::read_to_string(s.sandbox.logs.join("snapshot-app.log")).await?;
        let log = log
            .replace(&s.gw.token, "[redacted]")
            .replace(&s.agent.launch.admin_credential().unwrap(), "[redacted]");
        return Err(HarnessError(format!("snapshot executor failed: {log}")));
    }
    Ok(reply.body)
}
#[tokio::test]
async fn live_snapshot_app_open_close_reopen_preserves_registry_and_pages()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, proxy, browser) = setup().await?;
    let opened = call(
        &s,
        "tab.open",
        &Value::Null,
        json!({"url":"https://example.com/one"}),
    )
    .await?;
    assert_eq!(opened["status"], "ok", "{opened}");
    let tab = &opened["tab"];
    assert_eq!(
        call(&s, "tabs.list", &Value::Null, json!({})).await?["tabs"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(call(&s, "tab.close", tab, json!({})).await?["status"], "ok");
    assert_eq!(
        call(&s, "tabs.list", &Value::Null, json!({})).await?["tabs"],
        json!([])
    );
    let reopened = call(
        &s,
        "tab.open",
        &Value::Null,
        json!({"url":"https://example.com/two"}),
    )
    .await?;
    assert_eq!(reopened["status"], "ok", "{reopened}");
    assert_ne!(reopened["tab"], *tab);
    let read = call(&s, "tab.read", &reopened["tab"], json!({})).await?;
    assert!(read.to_string().contains("Second snapshot"), "{read}");
    assert_eq!(proxy.traffic.lock().unwrap().unknown_host_ops, 0);
    assert_eq!(proxy.traffic.lock().unwrap().refused_hosts.len(), 0);
    browser.kill().await;
    s.finish().await
}
#[tokio::test]
async fn live_snapshot_app_capacity_navigation_and_screenshot_use_app_executor()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, proxy, browser) = setup().await?;
    let mut opened = Value::Null;
    for _ in 0..butler_runtime::browser::capacity::agent_tabs() + 2 {
        opened = call(
            &s,
            "tab.open",
            &Value::Null,
            json!({"url":"https://example.com/one"}),
        )
        .await?;
        assert_eq!(opened["status"], "ok", "{opened}");
    }
    let tabs = call(&s, "tabs.list", &Value::Null, json!({})).await?;
    assert_eq!(
        tabs["tabs"].as_array().unwrap().len(),
        butler_runtime::browser::capacity::agent_tabs()
    );
    let tab = &opened["tab"];
    let observed = call(
        &s,
        "tab.observe",
        tab,
        json!({"scope":"text","include_image":true}),
    )
    .await?;
    assert_eq!(observed["status"], "ok", "{observed}");
    let link = observed["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["role"] == "link" && n["name"] == "Next")
        .unwrap();
    let screenshot = call(
        &s,
        "tab.screenshot",
        tab,
        json!({"observation":observed["obs"],"ref":link["ref"]}),
    )
    .await?;
    assert_eq!(screenshot["status"], "ok", "{screenshot}");
    assert!(
        screenshot["image"]["data"]
            .as_str()
            .is_some_and(|s| !s.is_empty())
    );
    let steps = json!([{"action":"click","ref":link["ref"]}]);
    let prepared = call(
        &s,
        "tab.prepare",
        tab,
        json!({"observation":observed["obs"],"steps":steps}),
    )
    .await?;
    assert_eq!(prepared["status"], "ok", "{prepared}");
    let acted = call(
        &s,
        "tab.act",
        tab,
        json!({"observation":observed["obs"],"steps":steps,"prepared_steps":prepared["steps"]}),
    )
    .await?;
    assert_eq!(acted["steps"][0]["status"], "completed", "{acted}");
    let read = call(&s, "tab.read", tab, json!({})).await?;
    assert!(read.to_string().contains("Second snapshot"), "{read}");
    assert_eq!(proxy.traffic.lock().unwrap().unknown_host_ops, 0);
    assert_eq!(proxy.traffic.lock().unwrap().refused_hosts.len(), 0);
    browser.kill().await;
    s.finish().await
}

#[tokio::test]
async fn live_snapshot_missing_urls_and_clicked_links_load_http_404() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, proxy, browser) = setup().await?;
    let direct = "https://absent.example/no-page";
    let opened = call(&s, "tab.open", &Value::Null, json!({"url":direct})).await?;
    assert_eq!(opened["status"], "ok", "{opened}");
    assert_not_found(&s, &opened["tab"], direct).await?;
    let source = call(
        &s,
        "tab.open",
        &Value::Null,
        json!({"url":"https://example.com/one"}),
    )
    .await?;
    let tab = &source["tab"];
    let observed = call(&s, "tab.observe", tab, json!({"scope":"text"})).await?;
    let link = observed["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|node| node["role"] == "link" && node["name"] == "Missing")
        .unwrap();
    let steps = json!([{"action":"click","ref":link["ref"]}]);
    let prepared = call(
        &s,
        "tab.prepare",
        tab,
        json!({"observation":observed["obs"],"steps":steps}),
    )
    .await?;
    let acted = call(
        &s,
        "tab.act",
        tab,
        json!({"observation":observed["obs"],"steps":steps,"prepared_steps":prepared["steps"]}),
    )
    .await?;
    assert_eq!(acted["steps"][0]["status"], "completed", "{acted}");
    let clicked = "https://missing.example/absent";
    assert_not_found(&s, tab, clicked).await?;
    assert_private_refused(&s).await?;
    {
        let traffic = proxy.traffic.lock().unwrap();
        for url in [direct, clicked] {
            assert!(traffic.offline_misses.iter().any(|u| u == url));
        }
        assert_eq!(traffic.unknown_host_ops, 0);
        assert_eq!(traffic.refused_hosts, [] as [String; 0]);
    }
    browser.kill().await;
    s.finish().await
}
async fn assert_not_found(s: &Scenario, tab: &Value, url: &str) -> Result<(), HarnessError> {
    let read = call(s, "tab.read", tab, json!({})).await?;
    assert!(read.to_string().contains("Not Found"), "{read}");
    let network = call(s, "tab.devtools", tab, json!({"read":"network"})).await?;
    let page = &network["untrusted_content"];
    assert_eq!(page["url"], url, "{network}");
    assert!(
        page["entries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["url"] == url && row["status"] == 404),
        "{network}"
    );
    Ok(())
}
async fn assert_private_refused(s: &Scenario) -> Result<(), HarnessError> {
    let admin = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let reply = admin
        .send(
            reqwest::Method::POST,
            "/internal/browser/calls",
            Some(json!({"session":"general","op":"tab.open","args":{"url":"http://127.0.0.1/private"}})),
            &[],
        )
        .await?;
    assert_eq!(reply.status, 400, "{}", reply.text);
    assert_eq!(reply.body["error"]["code"], "navigation_denied");
    Ok(())
}
