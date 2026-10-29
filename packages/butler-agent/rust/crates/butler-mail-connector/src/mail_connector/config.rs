use super::Result;
use serde_json::Value;
use std::{net::IpAddr, path::PathBuf};

pub(super) struct Endpoint {
    pub host: String,
    pub port: u16,
    pub security: String,
}
pub(super) struct Config {
    pub address: String,
    pub username: String,
    pub password: String,
    pub smtp_password: String,
    pub imap: Endpoint,
    pub smtp: Endpoint,
    pub data: PathBuf,
    pub timeout: std::time::Duration,
}
impl Config {
    pub(super) fn load() -> Result<Self> {
        let fields: Value = serde_json::from_str(
            &std::env::var("BUTLER_CONNECTOR_FIELDS").map_err(|_| "mail_config_missing")?,
        )
        .map_err(|_| "mail_config_invalid")?;
        let address = super::text(&fields, "address")?.to_owned();
        let username = fields["username"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or(&address)
            .to_owned();
        let password = std::env::var("IMAP_PASSWORD").map_err(|_| "mail_secret_missing")?;
        let smtp_password = std::env::var("SMTP_PASSWORD")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| password.clone());
        let account =
            std::env::var("BUTLER_CONNECTOR_ACCOUNT").unwrap_or_else(|_| "operation".into());
        if !account
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return Err("mail_account_invalid");
        }
        Ok(Self {
            timeout: deadline()?,
            imap: Endpoint::read(&fields, "imap", 993, 143)?,
            smtp: Endpoint::read(&fields, "smtp", 465, 587)?,
            data: PathBuf::from(
                std::env::var("BUTLER_PLUGIN_DATA").map_err(|_| "mail_data_missing")?,
            )
            .join(account),
            address,
            username,
            password,
            smtp_password,
        })
    }
}
impl Endpoint {
    fn read(fields: &Value, prefix: &str, tls_port: u16, starttls_port: u16) -> Result<Self> {
        let host = super::text(fields, &format!("{prefix}_host"))?.to_owned();
        let security = fields[format!("{prefix}_security")]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or("tls")
            .to_owned();
        if !matches!(security.as_str(), "tls" | "starttls" | "plain") {
            return Err("mail_security_invalid");
        }
        // Literal loopback addresses only: no DNS rebinding or remote plaintext login.
        if security == "plain" && !host.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback()) {
            return Err("mail_plaintext_refused");
        }
        let port = fields[format!("{prefix}_port")]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::parse::<u16>)
            .transpose()
            .map_err(|_| "mail_port_invalid")?
            .unwrap_or(if security == "tls" {
                tls_port
            } else {
                starttls_port
            });
        if port == 0 {
            return Err("mail_port_invalid");
        }
        Ok(Self {
            host,
            port,
            security,
        })
    }
}

fn deadline() -> Result<std::time::Duration> {
    let millis = std::env::var("BUTLER_CONNECTOR_CALL_TIMEOUT_MS").map_or(Ok(15_000), |s| {
        s.parse::<u64>().map_err(|_| "mail_deadline_invalid")
    })?;
    let upstream = millis
        .checked_sub(1000)
        .filter(|v| *v > 0)
        .ok_or("mail_deadline_invalid")?;
    Ok(std::time::Duration::from_millis(upstream))
}
