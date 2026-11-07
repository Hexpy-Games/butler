//! Fetches the open session as the C0 wire `SessionView` (`ShellClient::message_window`) for
//! `store::messages::MessageCache`.
use super::{convert, wire};
use butler_shell_client::{Error, ShellClient};

/// The most messages one window carries (the gateway's `session-view` maximum).
const WINDOW_LIMIT: u32 = 200;

/// Opens `session`, or reads the window older than `before` (a `previous_cursor_token`).
#[allow(
    dead_code,
    reason = "P2 shell-wave skeleton: wired by Opus at wave integration"
)]
pub(crate) async fn fetch(
    client: &ShellClient,
    session: &str,
    before: Option<&str>,
) -> Result<wire::SessionView, Error> {
    let raw = client.message_window(session, before, WINDOW_LIMIT).await?;
    convert::decode(&raw)
}
