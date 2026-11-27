use super::helpers::*;
use butler_e2e::e2e::{HarnessError, scenario::Setup};
use serde_json::Value;
use std::{process::Stdio, time::Duration};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, Lines};

/// The next issued code with the pairing link printed above it; asserts its QR was drawn.
async fn next_pairing(
    lines: &mut Lines<BufReader<tokio::process::ChildStdout>>,
) -> Result<(String, String), HarnessError> {
    Ok(tokio::time::timeout(Duration::from_secs(10), async {
        let (mut qr, mut link) = (false, String::new());
        while let Some(line) = lines.next_line().await.unwrap() {
            qr |= line.contains('▀') || line.contains('▄');
            if let Some(value) = line.strip_prefix("Link: ") {
                link = value.to_owned();
            }
            if let Some(code) = line.strip_prefix("Pairing code: ") {
                assert!(qr, "QR missing before code");
                return (link, code.to_owned());
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
    app.set_remote(true).await?;
    assert_eq!(
        s.agent
            .cli(&["remote", "hosts", "add", "butler.example.com"])?
            .code,
        Some(0)
    );
    let view = app.view().await?;
    let mut command = tokio::process::Command::from(s.agent.launch.command());
    let mut child = command
        .args(["remote", "pair"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    for url in view["lan_urls"].as_array().unwrap() {
        let line = tokio::time::timeout(Duration::from_secs(10), lines.next_line())
            .await
            .expect("CLI address timeout")?
            .expect("CLI stopped before address");
        assert_eq!(line, format!("Address: {}", url.as_str().unwrap()));
    }
    assert!(
        view["lan_urls"]
            .as_array()
            .unwrap()
            .contains(&serde_json::json!("https://butler.example.com"))
    );
    let (_, first) = next_pairing(&mut lines).await?;
    assert_eq!(first.len(), 8);
    advance(&app, 60).await?;
    let (_, second) = next_pairing(&mut lines).await?;
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
    let (link, third) = next_pairing(&mut lines).await?;
    assert_ne!(third, second);
    let parsed = url::Url::parse(&link).unwrap();
    assert_eq!(
        (parsed.scheme(), parsed.host_str()),
        ("butler", Some("pair"))
    );
    let pairs: Vec<(String, String)> = parsed.query_pairs().into_owned().collect();
    let origins: Vec<&str> = view["lan_urls"]
        .as_array()
        .unwrap()
        .iter()
        .take(4)
        .map(|u| u.as_str().unwrap())
        .collect();
    let mut expected = vec![("v".to_owned(), "1".to_owned())];
    expected.extend(origins.iter().map(|o| ("a".to_owned(), (*o).to_owned())));
    expected.push(("c".to_owned(), third.clone()));
    assert_eq!(pairs, expected);
    let mut stdin = child.stdin.take().unwrap();
    let (response, answer) = tokio::join!(
        connect(&s.gw, &browser, &pairs.last().unwrap().1),
        tokio::time::timeout(Duration::from_secs(10), async {
            while !lines
                .next_line()
                .await?
                .expect("CLI stopped before prompt")
                .starts_with("Confirmation number: ")
            {}
            let mut prompt = [0; b"Allow? [y/N] ".len()];
            lines.get_mut().read_exact(&mut prompt).await?;
            assert_eq!(&prompt, b"Allow? [y/N] ");
            stdin.write_all(b"y\n").await
        }),
    );
    answer.expect("CLI prompt timeout")?;
    let response = response?;
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
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;
    let mut alias_lines = BufReader::new(alias.stdout.take().unwrap()).lines();
    let (_, code) = next_pairing(&mut alias_lines).await?;
    let mut alias_stdin = alias.stdin.take().unwrap();
    let (response, answer) = tokio::join!(
        connect(&s.gw, &browser, &code),
        tokio::time::timeout(Duration::from_secs(10), async {
            while !alias_lines
                .next_line()
                .await?
                .expect("CLI stopped before prompt")
                .starts_with("Confirmation number: ")
            {}
            let mut prompt = [0; b"Allow? [y/N] ".len()];
            alias_lines.get_mut().read_exact(&mut prompt).await?;
            assert_eq!(&prompt, b"Allow? [y/N] ");
            alias_stdin.write_all(b"y\n").await
        }),
    );
    answer.expect("CLI alias prompt timeout")?;
    assert_eq!(response?.status().as_u16(), 303);
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
