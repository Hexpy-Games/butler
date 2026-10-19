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
    oauth_cli(None).await
}

#[tokio::test]
async fn log_http_native_oauth_cli_exit_bounds_stalled_close() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    oauth_cli(Some("30000")).await
}

async fn oauth_cli(close_delay: Option<&str>) -> Result<(), HarnessError> {
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
    help_without_logging(&s)?;
    run_cli(&s, port, close_delay).await?;
    let rows = http_calls(&s, &format!("{}/oauth/token", token.base_url)).await?;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["attrs"]["purpose"], "oauth");
    assert_eq!(rows[0]["attrs"]["status"], 200);
    assert_eq!(
        rows[0]["content"]["request"]["grant_type"],
        "authorization_code"
    );
    assert_eq!(rows[0]["content"]["request"]["code"], "[REDACTED]");
    assert!(!serde_json::to_string(&rows)?.contains("private-native-cli-authorization-code"));
    assert!(
        token
            .seen()
            .iter()
            .all(|r| !r.headers.contains_key("traceparent"))
    );
    s.finish().await
}

async fn run_cli(
    s: &butler_e2e::e2e::scenario::Scenario,
    port: u16,
    close_delay: Option<&str>,
) -> Result<(), HarnessError> {
    let stderr = std::fs::File::create(s.agent.launch.logs.join("oauth-cli.log"))?;
    let mut command = tokio::process::Command::from(s.agent.launch.command());
    if let Some(delay) = close_delay {
        command.env("BUTLER_E2E_LOG_CLOSE_DELAY_MS", delay);
    }
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
    let exit_start = std::time::Instant::now();
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
    eprintln!(
        "LOG-HTTP-CLI callback_to_exit_ms={:.3}",
        exit_start.elapsed().as_secs_f64() * 1000.0
    );
    let stderr = std::fs::read_to_string(s.agent.launch.logs.join("oauth-cli.log"))?;
    if close_delay.is_some() {
        assert_eq!(stderr.matches("http_logging_close_failed").count(), 1);
        assert!(stderr.contains("log writer shutdown timed out"));
    } else {
        assert!(!stderr.contains("http_logging_close_failed"));
    }
    Ok(())
}

fn help_without_logging(s: &butler_e2e::e2e::scenario::Scenario) -> Result<(), HarnessError> {
    let data = s.sandbox.root.join("help-data");
    std::fs::create_dir(&data)?;
    let start = std::time::Instant::now();
    let output = s
        .agent
        .launch
        .command()
        .env("BUTLER_DATA", &data)
        .args(["--help", "--json"])
        .output()?;
    let elapsed = start.elapsed();
    assert!(output.status.success());
    let help: serde_json::Value = serde_json::from_slice(&output.stdout)?;
    assert!(
        help["data"]["commands"]
            .as_array()
            .is_some_and(|commands| !commands.is_empty())
    );
    assert!(!data.join("logs").exists());
    assert_eq!(output.stderr, b"");
    eprintln!(
        "LOG-HTTP-CLI help_ms={:.3} log_files=0",
        elapsed.as_secs_f64() * 1000.0
    );
    Ok(())
}
