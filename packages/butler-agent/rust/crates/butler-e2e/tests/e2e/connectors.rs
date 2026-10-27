//! Stub-only connected-source acceptance through real admin and model boundaries.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
mod intake;
mod lifecycle;
mod review;
mod review_access;
mod review_secrets;
mod review_transport;
mod round_three_browser;
mod round_three_memory;
mod round_three_steering;
mod round_three_work;
mod round_three_worker;
mod round_two;
mod round_two_access;
mod round_two_cleanup;
mod round_two_delegation;
mod rules;
pub(crate) mod stub;
use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    gateway::Reply,
    scenario::{Scenario, Setup},
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
        .env("BUTLER_SECRET_STORE", "system");
    butler_platform::secrets::prepare_system_keychain_for_test(&setup.sandbox.home)?;
    Ok(setup)
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
fn package(home: &Path, crash: bool) -> Result<PathBuf, HarnessError> {
    let root = home.join("source-plugin");
    fs::create_dir_all(&root)?;
    fs::copy(
        butler_e2e::e2e::binary::mcp_fixture_binary()?,
        root.join("server.exe"),
    )?;
    fs::write(root.join("plugin.json"),json!({"name":"source","version":"1.0.0","extensions":{"io.github.hexpy-games.butler":{"api":1,"connectors":[{
        "id":"items","label":"Items","account":{"fields":[{"key":"address","label":"Address"}],"secrets":[{"key":"ACCESS_KEY","label":"Key"}]},
        "events":{"server":"events"},"context":{"tool":"events/context"},"destinations":{"resource":"connector://destinations","argument":"destination"},
        "actions":[{"tool":"events/move","organize":true,"destination":true},{"tool":"events/mark_read","organize":true},{"tool":"events/send"}]
    }]}}}).to_string())?;
    fs::write(root.join("mcp.json"),json!({"mcpServers":{"events":{"command":"${BUTLER_PLUGIN_ROOT}/server.exe","env":{"E2E_MCP_MODE":"events","E2E_CONNECTOR_EXIT":crash.to_string()}}}}).to_string())?;
    Ok(root)
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
    assert_eq!(
        i.data()["capabilities"]["connectors"]["items"]["events"]["server"],
        "events"
    );
    let r=api(s,Method::POST,"/plugins/install",Some(json!({"staging_id":i.data()["staging_id"],"digest":i.data()["digest"],"revision":revision(s).await?,"secrets":{}}))).await?;
    assert_eq!(r.status, 200, "{r:?}");
    Ok(())
}
async fn connect(s: &Scenario, mode: &str, interval: f64) -> Result<String, HarnessError> {
    let r=api(s,Method::POST,"/connectors/source/items/accounts",Some(json!({"fields":{"address":"account@example.test"},"secrets":{"ACCESS_KEY":"connector-private-value"},"handling":{"mode":mode,"interval_minutes":interval},"revision":revision(s).await?}))).await?;
    assert_eq!(r.status, 200, "{r:?}");
    assert!(!r.text.contains("connector-private-value"));
    Ok(r.data()["account"].as_str().unwrap().into())
}
fn data(s: &Scenario) -> PathBuf {
    s.sandbox.data.join("plugins/data/source")
}
async fn account(s: &Scenario, id: &str, state: &str) -> Result<Value, HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let r = api(s, Method::GET, "/connectors", None).await?;
        assert_eq!(r.status, 200, "{r:?}");
        let a = r.data()["connectors"][0]["accounts"]
            .as_array()
            .unwrap()
            .iter()
            .find(|a| a["id"] == id)
            .unwrap()
            .clone();
        if a["state"] == state {
            return Ok(a);
        }
        assert!(Instant::now() < deadline, "state={a}, expected={state}");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}
async fn emit(s: &Scenario, id: &str, events: Vec<Value>) -> Result<(), HarnessError> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    let control: Value =
        serde_json::from_slice(&fs::read(data(s).join(format!("{id}-control.json")))?)?;
    let mut stream = tokio::net::TcpStream::connect(control["address"].as_str().unwrap()).await?;
    stream
        .write_all(format!("{}\n", json!({"events":events})).as_bytes())
        .await?;
    let mut reply = String::new();
    BufReader::new(stream).read_line(&mut reply).await?;
    assert!(reply.contains("true"));
    Ok(())
}
fn event(id: &str) -> Value {
    json!({"id":id,"dedupe_key":id,"thread_id":id,"received_at":chrono::Utc::now().to_rfc3339(),"from":{"display":"Source","address":"source@example.test"},"addressing":"broadcast","subject":format!("Item {id}"),"snippet":"Compact item","link":"https://example.test/item","attributes":{"List-Id":"updates.example.test"}})
}
fn db(s: &Scenario) -> rusqlite::Connection {
    rusqlite::Connection::open_with_flags(
        s.sandbox.data.join("app-server/butler-client.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap()
}
async fn count(s: &Scenario, sql: &str, n: i64) -> Result<(), HarnessError> {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let got: i64 = db(s).query_row(sql, [], |r| r.get(0))?;
        if got == n {
            return Ok(());
        }
        assert!(Instant::now() < deadline, "{sql}: got {got}, expected {n}");
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
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
