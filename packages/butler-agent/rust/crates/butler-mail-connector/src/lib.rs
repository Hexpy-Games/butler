//! Account-scoped, push-driven IMAP/SMTP MCP connector.
mod mail_connector;
pub use mail_connector::run;

/// Run the connector process and return its exit code, exposing only stable errors.
pub async fn run_process() -> i32 {
    match run().await {
        Ok(()) => 0,
        Err(code) => {
            // Only stable errors reach stderr. Server responses may echo credentials.
            eprintln!(
                "{}",
                if matches!(
                    code,
                    "mail_auth_failed" | "mail_idle_unsupported" | "mail_server_unsupported"
                ) {
                    code
                } else {
                    "mail_connector_failed"
                }
            );
            1
        }
    }
}
