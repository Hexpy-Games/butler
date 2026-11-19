//! Foreground pairing, usable without a display or terminal input.
use super::client::Client;
use crate::host::cli::error::CliError;
use qrcode::{EcLevel, QrCode, render::unicode};
use reqwest::Method;
use std::{
    io::{self, Write},
    time::Duration,
};

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
    for origin in &origins {
        println!("Address: {origin}");
    }
    loop {
        let issued = client
            .request(Method::POST, "/security/pairing", None)
            .await?;
        let code = issued["code"]
            .as_str()
            .ok_or_else(|| CliError::failed("pairing_unavailable", "Pairing unavailable."))?;
        if !origins.is_empty() {
            let link = pair_link(&origins, code);
            println!("\n{}", qr_text(&link)?);
            println!("Link: {link}");
        }
        println!("Pairing code: {code}");
        loop {
            let status = client
                .request(Method::GET, "/security/pairing", None)
                .await?;
            if status["id"] != issued["id"]
                || matches!(status["status"].as_str(), Some("expired" | "invalidated"))
            {
                println!("\nRefreshing pairing code.");
                break;
            }
            if status["status"] == "paired" && status["device_id"].is_string() {
                println!("\nDevice paired.");
                return Ok(());
            }
            let remaining = status["expires_in"].as_u64().unwrap_or(0);
            print!("\rExpires in {remaining:2}s · Ctrl-C to stop");
            io::stdout().flush().map_err(|_| {
                CliError::failed("output_unavailable", "Cannot write pairing countdown.")
            })?;
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    }
}

/// The phone app's pairing payload v1; matches the desktop QR.
fn pair_link(origins: &[&str], code: &str) -> String {
    let mut query = url::form_urlencoded::Serializer::new(String::new());
    query.append_pair("v", "1");
    for origin in origins.iter().take(4) {
        query.append_pair("a", origin);
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
