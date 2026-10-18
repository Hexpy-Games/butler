//! A separate CLI process must publish HTTP logs without deleting the service's logs.
use super::*;
use butler_e2e::e2e::{
    agent::free_port,
    scenario::{Fixture, Setup},
};
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, BufReader};

#[tokio::test]
async fn log_http_native_oauth_cli_publishes_redacted_request() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let token = FakeServer::oauth_token().await?;
    let port = free_port()?;
    let s = Setup::new("LOG-HTTP-CLI")?
        .fixture(Fixture::Empty)
        .without_credential()
        .env("BUTLER_CODEX_OAUTH_PORT", port.to_string())
        .env("BUTLER_CODEX_OAUTH_NO_BROWSER", "1")
        .env("BUTLER_CODEX_BASE_URL", &token.base_url)
        .env(
            "BUTLER_CODEX_OAUTH_TOKEN_URL",
            format!("{}/oauth/token", token.base_url),
        )
        .start()
        .await?;
    logging(&s, "full").await?;
    let stderr = std::fs::File::create(s.agent.launch.logs.join("oauth-cli.log"))?;
    let mut command = tokio::process::Command::from(s.agent.launch.command());
    let mut child = command
        .arg("oauth-login")
        .stdout(Stdio::piped())
        .stderr(stderr)
        .kill_on_drop(true)
        .spawn()?;
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    let mut authorize = String::new();
    tokio::time::timeout(Duration::from_secs(5), stdout.read_line(&mut authorize))
        .await
        .map_err(std::io::Error::other)??;
    let authorize = url::Url::parse(authorize.trim()).unwrap();
    let state = authorize
        .query_pairs()
        .find(|(key, _)| key == "state")
        .unwrap()
        .1
        .into_owned();
    let code = "private-native-cli-authorization-code";
    let (status, _) =
        super::super::setup_oauth::callback(port, &format!("code={code}&state={state}")).await?;
    assert_eq!(status, 200);
    assert!(
        tokio::time::timeout(Duration::from_secs(5), child.wait())
            .await
            .map_err(std::io::Error::other)??
            .success()
    );
    let rows = http_calls(&s, &format!("{}/oauth/token", token.base_url)).await?;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["attrs"]["purpose"], "oauth");
    assert_eq!(rows[0]["attrs"]["status"], 200);
    assert_eq!(
        rows[0]["content"]["request"]["grant_type"],
        "authorization_code"
    );
    assert_eq!(rows[0]["content"]["request"]["code"], "[REDACTED]");
    assert!(!serde_json::to_string(&rows)?.contains(code));
    assert!(
        token
            .seen()
            .iter()
            .all(|r| !r.headers.contains_key("traceparent"))
    );
    s.finish().await
}
