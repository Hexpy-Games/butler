mod actions;
mod config;
mod imap;
mod intake;
mod message;
mod outward;
mod server;
mod state;
mod transport;
use config::Config;
use serde_json::{Value, json};
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
type Result<T> = std::result::Result<T, &'static str>;

struct Mail {
    config: Config,
    state: Mutex<state::State>,
    connection_gate: Mutex<()>,
}
/// Run until the host closes stdin. Nothing is logged from remote errors.
pub async fn run() -> Result<()> {
    if std::env::var_os("BUTLER_CONNECTOR_FIELDS").is_none() {
        return server::serve(None).await;
    }
    let config = Config::load()?;
    let state = state::State::load(&config.data).await?;
    let mail = Arc::new(Mail {
        config,
        state: Mutex::new(state),
        connection_gate: Mutex::new(()),
    });
    server::serve(Some(mail)).await
}
impl Mail {
    async fn connect(&self, auth_failed: Option<&CancellationToken>) -> Result<imap::Connection> {
        let _gate = self.connection_gate.lock().await;
        if auth_failed.is_some_and(CancellationToken::is_cancelled) {
            return Err("mail_auth_failed");
        }
        let result = imap::connect(&self.config).await;
        if result
            .as_ref()
            .err()
            .is_some_and(|code| *code == "mail_auth_failed")
            && let Some(auth_failed) = auth_failed
        {
            auth_failed.cancel();
        }
        result
    }
}
fn text<'a>(args: &'a Value, key: &str) -> Result<&'a str> {
    args.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or("mail_argument_invalid")
}
