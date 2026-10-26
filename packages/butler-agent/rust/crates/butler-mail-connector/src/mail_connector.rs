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
    terminal: Mutex<Option<&'static str>>,
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
        terminal: Mutex::new(None),
    });
    server::serve(Some(mail)).await
}
impl Mail {
    async fn bounded<T>(&self, future: impl std::future::Future<Output = Result<T>>) -> Result<T> {
        tokio::time::timeout(self.config.timeout, future)
            .await
            .map_err(|_| "mail_operation_timeout")?
    }
    async fn connect(
        &self,
        failed: Option<&CancellationToken>,
    ) -> Result<(imap::Connection, Option<async_imap::types::Mailbox>)> {
        let _gate = self.connection_gate.lock().await;
        if failed.is_some_and(CancellationToken::is_cancelled) {
            return Err(self.terminal.lock().await.unwrap_or("mail_auth_failed"));
        }
        let result = self
            .bounded(async {
                let mut connection = imap::connect(&self.config).await?;
                let inbox = if failed.is_some() {
                    Some(imap::inbox(&mut connection).await?)
                } else {
                    None
                };
                Ok((connection, inbox))
            })
            .await;
        if let Err(
            code @ ("mail_auth_failed" | "mail_idle_unsupported" | "mail_server_unsupported"),
        ) = &result
            && let Some(failed) = failed
        {
            *self.terminal.lock().await = Some(*code);
            failed.cancel();
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
