//! Foreground pairing; the owner allows each request on this terminal.
use super::client::Client;
use crate::host::cli::error::CliError;
use qrcode::{EcLevel, QrCode, render::unicode};
use reqwest::Method;
use serde_json::{Value, json};
use std::{
    io::{self, Write},
    time::Duration,
};
use tokio::io::{AsyncBufReadExt, BufReader, Lines, Stdin};

pub(super) async fn run(client: &Client) -> Result<(), CliError> {
    let cancelled = tokio::signal::ctrl_c();
    tokio::pin!(cancelled);
    tokio::select! {
        result = foreground(client) => result,
        _ = &mut cancelled => { println!("\nPairing cancelled."); Ok(()) }
    }
}

async fn foreground(client: &Client) -> Result<(), CliError> {
    let view = client.request(Method::GET, "/security", None).await?;
    let origins: Vec<&str> = view["lan_urls"]
        .as_array()
        .map(|urls| urls.iter().filter_map(|url| url.as_str()).collect())
        .unwrap_or_default();
    let tunnel = &view["tunnel"];
    let relay = (tunnel["enabled"] == true)
        .then(|| {
            tunnel["public_key"]
                .as_str()
                .zip(tunnel["tunnel_id"].as_str())
                .map(|(key, id)| (key, id, tunnel["cloud"].as_str()))
        })
        .flatten();
    for origin in &origins {
        println!("Address: {origin}");
    }
    let mut input = BufReader::new(tokio::io::stdin()).lines();
    loop {
        let issued = client
            .request(Method::POST, "/security/pairing", None)
            .await?;
        let code = issued["code"]
            .as_str()
            .ok_or_else(|| CliError::failed("pairing_unavailable", "Pairing unavailable."))?;
        if !origins.is_empty() || relay.is_some() {
            let link = pair_link(&origins, code, relay);
            println!("\n{}", qr_text(&link)?);
            println!("Link: {link}");
        }
        println!("Pairing code: {code}");
        loop {
            let status = client
                .request(Method::GET, "/security/pairing", None)
                .await?;
            if status["id"] != issued["id"]
                || matches!(
                    status["status"].as_str(),
                    Some("expired" | "invalidated" | "rejected")
                )
            {
                println!("\nRefreshing pairing code.");
                break;
            }
            if status["status"] == "paired" && status["device_id"].is_string() {
                println!("\nDevice paired.");
                return Ok(());
            }
            if status["status"] == "pending" {
                answer(client, &issued["id"], &status["request"], &mut input).await?;
                continue;
            }
            if status["status"] != "approved" {
                let remaining = status["expires_in"].as_u64().unwrap_or(0);
                print!("\rExpires in {remaining:2}s · Ctrl-C to stop");
                io::stdout().flush().map_err(|_| {
                    CliError::failed("output_unavailable", "Cannot write pairing countdown.")
                })?;
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    }
}

async fn answer(
    client: &Client,
    id: &Value,
    request: &Value,
    input: &mut Lines<BufReader<Stdin>>,
) -> Result<(), CliError> {
    let name = request["device_name"].as_str().unwrap_or_default();
    let platform = request["platform"].as_str().unwrap_or_default();
    let number = request["match_code"].as_str().unwrap_or_default();
    print!("\n{name} ({platform}) wants to connect.\nConfirmation number: {number}\nAllow? [y/N] ");
    io::stdout()
        .flush()
        .map_err(|_| CliError::failed("output_unavailable", "Cannot write pairing prompt."))?;
    let allow = input.next_line().await.ok().flatten().is_some_and(|line| {
        let answer = line.trim();
        answer.eq_ignore_ascii_case("y") || answer.eq_ignore_ascii_case("yes")
    });
    if client
        .request(
            Method::POST,
            "/security/pairing/decision",
            Some(json!({"id": id, "allow": allow})),
        )
        .await
        .is_err()
    {
        println!("Request expired.");
    } else if !allow {
        println!("Declined.");
    }
    Ok(())
}

/// The phone app's pairing payload v1; matches the desktop QR.
fn pair_link(origins: &[&str], code: &str, relay: Option<(&str, &str, Option<&str>)>) -> String {
    let mut query = url::form_urlencoded::Serializer::new(String::new());
    query.append_pair("v", "1");
    for origin in origins.iter().take(4) {
        query.append_pair("a", origin);
    }
    if let Some((key, id, cloud)) = relay {
        query.append_pair("k", key);
        query.append_pair("t", id);
        if let Some(cloud) = cloud {
            query.append_pair("u", cloud);
        }
    }
    query.append_pair("c", code);
    format!("butler://pair?{}", query.finish())
}

/// Half-block QR drawn black on white with ANSI colours, so it scans on light and dark terminals.
fn qr_text(link: &str) -> Result<String, CliError> {
    let code = QrCode::with_error_correction_level(link, EcLevel::M)
        .map_err(|_| CliError::failed("pairing_unavailable", "Pairing unavailable."))?;
    let image = code.render::<unicode::Dense1x2>().quiet_zone(true).build();
    Ok(image
        .lines()
        .map(|line| format!("\x1b[30;47m{line}\x1b[0m"))
        .collect::<Vec<_>>()
        .join("\n"))
}
