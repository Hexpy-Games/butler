//! Foreground pairing, usable without a display or terminal input.
use super::client::Client;
use crate::host::cli::error::CliError;
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
    loop {
        let issued = client
            .request(Method::POST, "/security/pairing", None)
            .await?;
        let code = issued["code"]
            .as_str()
            .ok_or_else(|| CliError::failed("pairing_unavailable", "Pairing unavailable."))?;
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
