//! Real shell ordering before and after activity on an older chat.
use super::Shots;
use anyhow::Context as _;
use butler_e2e::e2e::scenario::Scenario;
use tokio::io::{AsyncBufReadExt as _, AsyncWriteExt as _, BufReader};

pub(super) async fn prepare(
    s: &Scenario,
    h: &mut Shots,
    clock: &str,
) -> anyhow::Result<(String, String)> {
    set_clock(clock, "2026-10-29T00:00:00Z").await?;
    let older = create(s, "Older").await?;
    set_clock(clock, "2026-10-29T00:01:00Z").await?;
    let newer = create(s, "Newer").await?;
    h.command(&format!("before {newer} {older}")).await?;
    h.command("shot activity-before").await?;
    h.command(&format!("open {older}")).await?;
    set_clock(clock, "2026-10-29T00:02:00Z").await?;
    Ok((older, newer))
}

async fn create(s: &Scenario, title: &str) -> anyhow::Result<String> {
    let response =
        s.gw.post(
            "/sessions",
            serde_json::json!({"kind":"chat","title":title}),
        )
        .await?;
    anyhow::ensure!(response.status == 201, "create session: {}", response.text);
    Ok(response.data()["session"]["id"]
        .as_str()
        .context("session id")?
        .to_owned())
}

#[allow(
    clippy::disallowed_methods,
    reason = "non-HTTP loopback fixture clock control"
)]
async fn set_clock(address: &str, value: &str) -> anyhow::Result<()> {
    let mut stream = tokio::net::TcpStream::connect(address).await?;
    stream.write_all(format!("{value}\n").as_bytes()).await?;
    let mut reply = String::new();
    BufReader::new(stream).read_line(&mut reply).await?;
    anyhow::ensure!(!reply.is_empty(), "clock acknowledgement");
    Ok(())
}
