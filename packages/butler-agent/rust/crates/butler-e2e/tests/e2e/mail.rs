//! Mail acceptance uses real plugin installation and account-bound MCP children.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "acceptance assertions"
)]
mod acceptance;
mod direct;
mod rejected_login;
mod review;
mod rules;
mod security;
mod stub;
use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    fake_imap::FakeImap,
    gateway::Reply,
    scenario::{Access, Scenario, Setup},
    security::AdminClient,
};
use reqwest::Method;
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
fn setup(name: &str) -> Result<Setup, HarnessError> {
    let setup = Setup::new(name)?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .access(Access::AskExceptReads)
        .env("BUTLER_SECRET_STORE", "system");
    butler_platform::secrets::prepare_system_keychain_for_test(&setup.sandbox.home)?;
    Ok(setup)
}
fn package(home: &Path) -> Result<PathBuf, HarnessError> {
    let root = home.join("mail-package");
    fs::create_dir_all(root.join("bin"))?;
    let source = butler_e2e::e2e::binary::workspace_root().join("../plugins/mail");
    fs::copy(source.join("plugin.json"), root.join("plugin.json"))?;
    fs::copy(
        butler_e2e::e2e::binary::fixture_binary("e2e-mail-connector")?,
        root.join("bin/butler-mail-connector"),
    )?;
    Ok(root)
}
async fn api(
    s: &Scenario,
    method: Method,
    path: &str,
    body: Option<Value>,
) -> Result<Reply, HarnessError> {
    AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap())
        .send(method, path, body, &[])
        .await
}
async fn revision(s: &Scenario) -> Result<u64, HarnessError> {
    Ok(
        api(s, Method::GET, "/plugins", None).await?.data()["revision"]
            .as_u64()
            .unwrap(),
    )
}
async fn install(s: &Scenario, root: &Path) -> Result<(), HarnessError> {
    let i = api(
        s,
        Method::POST,
        "/plugins/inspect",
        Some(json!({"path":root})),
    )
    .await?;
    assert_eq!(i.status, 200, "{i:?}");
    let r = api(s,Method::POST,"/plugins/install",Some(json!({"staging_id":i.data()["staging_id"],"digest":i.data()["digest"],"revision":revision(s).await?,"secrets":{}}))).await?;
    assert_eq!(r.status, 200, "{r:?}");
    Ok(())
}
fn fields(fake: &FakeImap) -> Value {
    json!({"address":"owner@example.test","username":"","imap_host":"127.0.0.1","imap_port":fake.imap_port.to_string(),"imap_security":"plain","smtp_host":"127.0.0.1","smtp_port":fake.smtp_port.to_string(),"smtp_security":"plain"})
}
async fn connect(s: &Scenario, fake: &FakeImap, password: &str) -> Result<String, HarnessError> {
    let r=api(s,Method::POST,"/connectors/mail/mail/accounts",Some(json!({"fields":fields(fake),"secrets":{"IMAP_PASSWORD":password},"handling":{"mode":"batch","interval_minutes":0.025},"revision":revision(s).await?}))).await?;
    assert_eq!(r.status, 200, "{r:?}");
    let id = r.data()["account"].as_str().unwrap().to_owned();
    wait(|| async { Ok(fake.commands().iter().any(|l| l.ends_with(" IDLE"))) }).await?;
    Ok(id)
}
async fn enabled(s: &Scenario, id: &str, enabled: bool) -> Result<(), HarnessError> {
    let r = api(
        s,
        Method::PATCH,
        &format!("/connectors/mail/mail/accounts/{id}"),
        Some(json!({"enabled":enabled,"revision":revision(s).await?})),
    )
    .await?;
    assert_eq!(r.status, 200, "{r:?}");
    Ok(())
}
fn db(s: &Scenario) -> rusqlite::Connection {
    rusqlite::Connection::open_with_flags(
        s.sandbox.data.join("app-server/butler-client.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap()
}
async fn count(s: &Scenario, sql: &str, expected: i64) -> Result<(), HarnessError> {
    wait(|| async {
        let actual: i64 = db(s).query_row(sql, [], |r| r.get(0))?;
        Ok(actual == expected)
    })
    .await
}
async fn wait<F, Fut>(mut condition: F) -> Result<(), HarnessError>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<bool, HarnessError>>,
{
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if condition().await? {
            return Ok(());
        }
        assert!(Instant::now() < deadline, "mail condition timed out");
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
}
fn rfc822(id: &str, subject: &str, to: &str, body: &str, headers: &str) -> String {
    format!(
        "From: Sender <sender@example.test>\r\nTo: {to}\r\nSubject: {subject}\r\nMessage-ID: <{id}>\r\n{headers}MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n{body}\r\n"
    )
}
fn event(s: &Scenario, key: &str) -> Value {
    let raw: String = db(s)
        .query_row(
            "SELECT data_json FROM app_connector_events WHERE dedupe_key=?1",
            [key],
            |r| r.get(0),
        )
        .unwrap();
    serde_json::from_str(&raw).unwrap()
}
async fn invoke(s: &Scenario, name: &str, args: Value) -> Result<(), HarnessError> {
    s.provider()?.set_chat_responder(stub::run);
    let (_, turn) = s
        .turn(
            "general",
            &format!("fixture-call:{}", json!({"name":name,"arguments":args})),
        )
        .await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    Ok(())
}
async fn card(s: &Scenario, tool: &str, args: Value) -> Result<String, HarnessError> {
    s.provider()?.set_chat_responder(stub::run);
    let accepted=s.gw.say("general",&format!("fixture-call:{}",json!({"name":"call_mcp_tool","arguments":{"server_id":"mail/mail","tool_name":tool,"arguments":args}}))).await?;
    let turn = butler_e2e::e2e::scenario::accepted_turn_id(&accepted)?;
    let state =
        s.gw.wait_turn(
            "general",
            &turn,
            &["waiting_for_form", "delivered", "failed"],
            Duration::from_secs(30),
        )
        .await?;
    assert_eq!(state["state"], "waiting_for_form", "{state}");
    let cards = s.gw.approval_requests("general").await?;
    let shown = serde_json::to_string(&cards)?;
    assert!(shown.contains(&format!("mcp:mail/mail/{tool}")), "{shown}");
    for (key, value) in args.as_object().unwrap() {
        assert!(shown.contains(value.as_str().unwrap_or(key)), "{shown}");
    }
    Ok(turn)
}
async fn approve(s: &Scenario, action: &str) -> Result<(), HarnessError> {
    for card in s.gw.approval_requests("general").await? {
        let r =
            s.gw.post(
                &format!(
                    "/authority-requests/{}/{action}?session_id=general",
                    card["request_ref"].as_str().unwrap()
                ),
                json!({"scope":"once"}),
            )
            .await?;
        assert_eq!(r.status, 202, "{r:?}");
    }
    Ok(())
}
