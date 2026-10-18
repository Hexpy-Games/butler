//! Headless remote management uses the running service, including rotated auth.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use butler_e2e::e2e::{HarnessError, agent::Launch, scenario::Setup, security::AdminClient};
use serde_json::Value;

fn data(agent: &butler_e2e::e2e::agent::Agent, args: &[&str]) -> Result<Value, HarnessError> {
    let output = agent.cli(args)?;
    assert_eq!(output.code, Some(0), "remote command failed");
    assert_eq!(output.stderr, "");
    Ok(output.json()?["data"].clone())
}

#[tokio::test]
async fn remote_cli_manages_live_security() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("CLI-REMOTE")?
        .data_folder_token()
        .start()
        .await?;
    let admin = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let before = data(&s.agent, &["remote", "status", "--json"])?;
    assert_eq!(before["remote_access_enabled"], false);
    assert_eq!(before["bind_addresses"].as_array().unwrap().len(), 1);
    let enabled = s.agent.cli(&["remote", "enable"])?;
    assert_eq!(enabled.code, Some(0));
    assert!(enabled.stdout.contains("butler remote pair"));
    let status = data(&s.agent, &["remote", "status", "--json"])?;
    assert_eq!(status, admin.view().await?);
    assert_eq!(status["remote_access_enabled"], true);
    assert!(status["bind_addresses"].as_array().unwrap().len() > 1);
    assert_ne!(
        status["lan_urls"].as_array().unwrap().as_slice(),
        [] as [serde_json::Value; 0]
    );
    for url in status["lan_urls"].as_array().unwrap() {
        assert!(enabled.stdout.contains(url.as_str().unwrap()));
    }
    let devices = data(&s.agent, &["remote", "devices", "--json"])?;
    assert_eq!(devices, serde_json::json!([]));
    assert!(!status.to_string().contains(&s.gw.token));
    for (action, present) in [("add", true), ("remove", false)] {
        assert_eq!(
            s.agent
                .cli(&["remote", "hosts", action, "192.0.2.10"])?
                .code,
            Some(0)
        );
        let view = data(&s.agent, &["remote", "status", "--json"])?;
        assert_eq!(
            view["allowed_hosts"]
                .as_array()
                .unwrap()
                .contains(&Value::from("192.0.2.10")),
            present
        );
    }
    assert_eq!(s.agent.cli(&["remote", "disable"])?.code, Some(0));
    let disabled = data(&s.agent, &["remote", "status", "--json"])?;
    assert_eq!(disabled["remote_access_enabled"], false);
    assert_eq!(disabled["bind_addresses"].as_array().unwrap().len(), 1);
    assert_eq!(disabled["lan_urls"], serde_json::json!([]));
    assert_eq!(disabled["bind_errors"], serde_json::json!([]));
    for address in status["bind_addresses"].as_array().unwrap().iter().skip(1) {
        assert!(
            tokio::net::TcpStream::connect(address.as_str().unwrap())
                .await
                .is_err(),
            "LAN listener remains bound"
        );
    }
    s.agent.terminate().await?;
    let stopped = s.agent.cli(&["remote", "status", "--json"])?;
    assert_ne!(stopped.code, Some(0));
    assert_eq!(stopped.json()?["error"]["code"], "service_not_running");
    assert!(
        stopped.json()?["error"]["message"]
            .as_str()
            .unwrap()
            .contains("butler start")
    );
    s.finish().await
}

#[test]
fn remote_cli_reports_stopped_service_without_starting() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut setup = Setup::new("CLI-REMOTE-OFF")?;
    let launch = Launch::new(&setup.sandbox)?;
    let output = launch
        .command()
        .args(["remote", "status", "--json"])
        .output()?;
    assert!(!output.status.success());
    let result: Value = serde_json::from_slice(&output.stdout)?;
    assert_eq!(result["error"]["code"], "service_not_running");
    assert!(
        result["error"]["message"]
            .as_str()
            .unwrap()
            .contains("butler start")
    );
    assert!(
        !setup
            .sandbox
            .data
            .join("app/runtime/auth/local-admin.json")
            .exists()
    );
    setup.sandbox.mark_success();
    Ok(())
}

#[tokio::test]
async fn remote_cli_data_equals_and_unavailable_logger() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("CLI-HTTP-FAIL-OPEN")?
        .data_folder_token()
        .start()
        .await?;
    super::outbound_http::logging(&s, "detailed").await?;
    let data = format!("--data={}", s.sandbox.data.display());
    let unused = s.sandbox.home.join("unused-data");
    let output = s
        .agent
        .launch
        .command()
        .env("BUTLER_DATA", &unused)
        .args([&data, "remote", "status", "--json"])
        .output()?;
    assert!(output.status.success());
    assert_eq!(output.stderr, [] as [u8; 0]);
    assert!(!unused.exists());
    let logs = s.gw.get("/logs?category=http.local&limit=1000").await?;
    assert!(
        logs.data()["rows"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["event"] == "http.request" && r["attrs"]["path"] == "/security")
    );
    // The CLI shares the service's log directory, whose open files prevent
    // renaming it on Windows. Give only the CLI an unusable logs path while
    // retaining the same loopback port (Launch) and data-folder credentials.
    let cli_data = s.sandbox.home.join("cli-data");
    std::fs::create_dir_all(cli_data.join("app/runtime/auth"))?;
    for credential in [
        butler_e2e::e2e::agent::DATA_FOLDER_TOKEN_FILE,
        butler_e2e::e2e::agent::DATA_FOLDER_ADMIN_FILE,
    ] {
        std::fs::copy(s.sandbox.data.join(credential), cli_data.join(credential))?;
    }
    std::fs::write(cli_data.join("logs"), b"unavailable log directory")?;
    let cli_data = format!("--data={}", cli_data.display());
    let output = s.agent.cli(&[&cli_data, "remote", "status", "--json"])?;
    assert_eq!(output.code, Some(0));
    assert_eq!(output.stderr.matches("http_logging_unavailable").count(), 1);
    assert!(output.json()?["data"]["remote_access_enabled"].is_boolean());
    s.finish().await
}
