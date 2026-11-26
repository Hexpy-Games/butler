use std::collections::BTreeSet;

use axum::extract::ws::WebSocket;
use serde_json::Value;

use super::FakeButlerCloud;

#[derive(Default)]
pub(super) struct FakePush {
    pub(super) registered: BTreeSet<String>,
    pub(super) sends: Vec<Value>,
    pub(super) gone: Option<String>,
}

impl FakeButlerCloud {
    #[expect(
        clippy::expect_used,
        reason = "Tunnel scenarios fetch the accepted desktop socket"
    )]
    pub async fn tunnel_socket(&self) -> WebSocket {
        self.tunnel
            .lock()
            .await
            .recv()
            .await
            .expect("desktop tunnel socket")
    }

    pub fn push_sends(&self) -> Vec<Value> {
        self.state
            .push
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .sends
            .clone()
    }

    pub fn set_push_gone(&self, token: &str) {
        self.state
            .push
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .gone = Some(token.to_owned());
    }
}
