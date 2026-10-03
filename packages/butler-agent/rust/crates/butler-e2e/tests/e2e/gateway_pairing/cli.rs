use super::helpers::*;
use butler_e2e::e2e::{HarnessError, scenario::Setup};
use serde_json::Value;
use std::{process::Stdio, time::Duration};
use tokio::io::{AsyncBufReadExt, BufReader, Lines};

async fn next_code(
    lines: &mut Lines<BufReader<tokio::process::ChildStdout>>,
) -> Result<String, HarnessError> {
    Ok(tokio::time::timeout(Duration::from_secs(10), async {
        while let Some(line) = lines.next_line().await.unwrap() {
            if let Some(code) = line.strip_prefix("Pairing code: ") {
                return code.to_owned();
            }
        }
        panic!("CLI stopped before issuing a code");
    })
    .await
    .expect("CLI code timeout"))
}

#[tokio::test]
async fn sec_15_headless_cli_refreshes_and_exits_on_pair() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("SEC-15")?.data_folder_token().start().await?;
    let app = admin(&s);
    let browser = browser();
    let mut command = tokio::process::Command::from(s.agent.launch.command());
    let mut child = command
        .args(["remote", "pair"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let first = next_code(&mut lines).await?;
    assert_eq!(first.len(), 8);
    advance(&app, 60).await?;
    let second = next_code(&mut lines).await?;
    assert_ne!(second, first);
    assert_eq!(
        connect(&s.gw, &browser, &first).await?.status().as_u16(),
        401
    );
    for _ in 0..2 {
        assert_eq!(
            connect(&s.gw, &browser, "wrong").await?.status().as_u16(),
            401
        );
    }
    let third = next_code(&mut lines).await?;
    assert_ne!(third, second);
    let response = connect(&s.gw, &browser, &third).await?;
    assert_eq!(response.status().as_u16(), 303);
    let mut output = String::new();
    tokio::time::timeout(Duration::from_secs(10), async {
        while let Some(line) = lines.next_line().await.unwrap() {
            output.push_str(&line);
        }
    })
    .await
    .expect("CLI completion timeout");
    assert!(output.contains("Device paired."));
    assert!(
        tokio::time::timeout(Duration::from_secs(5), child.wait())
            .await
            .expect("CLI exit timeout")?
            .success()
    );
    let listed = s.agent.cli(&["remote", "devices", "--json"])?;
    assert_eq!(listed.code, Some(0));
    let data = listed.json()?["data"].clone();
    assert_eq!(data.as_array().unwrap().len(), 1);
    let id = data[0]["id"].as_str().unwrap();
    assert_eq!(
        s.agent.cli(&["remote", "devices", "--revoke", id])?.code,
        Some(0)
    );
    assert_eq!(read(&s.gw, &browser, &cookie_pair(&response)).await?, 401);
    assert_eq!(
        s.agent.cli(&["remote", "devices", "--revoke-all"])?.code,
        Some(0)
    );
    // Hidden preview alias enters the same foreground flow without a browser.
    let mut alias_command = tokio::process::Command::from(s.agent.launch.command());
    let mut alias = alias_command
        .args(["remote", "code"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;
    let mut alias_lines = BufReader::new(alias.stdout.take().unwrap()).lines();
    let code = next_code(&mut alias_lines).await?;
    assert_eq!(
        connect(&s.gw, &browser, &code).await?.status().as_u16(),
        303
    );
    assert!(
        tokio::time::timeout(Duration::from_secs(5), alias.wait())
            .await
            .expect("alias exit timeout")?
            .success()
    );
    let help = s.agent.cli(&["help", "remote"])?;
    assert!(help.stdout.contains("remote pair"));
    assert!(!help.stdout.contains("remote code"));
    let state: Value = s.agent.cli(&["remote", "devices", "--json"])?.json()?["data"].clone();
    assert_eq!(state.as_array().unwrap().len(), 1);
    assert_no_secrets(&s, &[&first, &second, &third, &code])?;
    s.finish().await
}
