use super::*;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

pub(crate) async fn setup(name: &str, now: &str) -> Result<(Scenario, String), HarnessError> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    let address = listener.local_addr()?.to_string();
    drop(listener);
    let mut cassette = Cassette::load("TURN-01")?;
    cassette.exchanges.clear();
    let setup = Setup::new(name)?
        .stub_cassette(cassette)
        .env("TZ", "UTC")
        .env("BUTLER_MEMORY_SYNC_TRACE", "1")
        .env("BUTLER_E2E_APP_NOW", now)
        .env("BUTLER_E2E_APP_CLOCK_ADDRESS", &address);
    super::super::memory_fixture::initialize_empty(&setup.sandbox.data)?;
    let s = setup.start().await?;
    s.provider()?.set_chat_responder(|_| {
        Some(butler_e2e::e2e::provider::title_response(
            "Complete scheduled report.",
        ))
    });
    let reply = s.gw.patch("/settings", json!({"timezone":"UTC"})).await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    Ok((s, address))
}
pub(crate) async fn clock(address: &str, value: &str) -> Result<(), HarnessError> {
    let mut stream = tokio::net::TcpStream::connect(address).await?;
    stream.write_all(format!("{value}\n").as_bytes()).await?;
    let mut reply = String::new();
    BufReader::new(stream).read_line(&mut reply).await?;
    Ok(())
}
pub(crate) async fn create(
    s: &Scenario,
    id: &str,
    target: &str,
    at: &str,
) -> Result<(), HarnessError> {
    let r = s.gw.post("/automations",json!({"id":id,"title":"Daily report","prompt_body":"Prepare a report.",
        "target_session_id":target,"schedule_type":"interval","interval_seconds":86400,"start_at":at})).await?;
    assert_eq!(r.status, 201, "{}", r.text);
    Ok(())
}
pub(crate) async fn runs(s: &Scenario, id: &str) -> Result<Vec<Value>, HarnessError> {
    Ok(
        s.gw.get(&format!("/automations/{id}/runs")).await?.data()["runs"]
            .as_array()
            .unwrap()
            .clone(),
    )
}
pub(crate) async fn report(s: &Scenario, id: &str) -> Result<Value, HarnessError> {
    tokio::time::timeout(Duration::from_secs(90), async {
        loop {
            if let Some(message) = s.gw.messages("general").await?.into_iter().find(|m| {
                m["initiated"]["kind"] == "schedule_report"
                    && m["initiated"]["automation_id"] == id
                    && m["status"] == "delivered"
            }) {
                return Ok::<_, HarnessError>(message);
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("initiated report delivery")
}
