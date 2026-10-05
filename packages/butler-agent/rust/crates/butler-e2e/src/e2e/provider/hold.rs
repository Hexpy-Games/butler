//! Explicit reply barriers for deterministic concurrent stub scenarios.
use crate::e2e::cassette::MatchKey;
use tokio::sync::oneshot;

/// Releases a single held provider reply; dropping it also releases the reply.
#[must_use]
pub struct ReplyGate(Option<oneshot::Sender<()>>);

impl ReplyGate {
    pub fn release(mut self) {
        if let Some(sender) = self.0.take() {
            let _ = sender.send(());
        }
    }
}

#[derive(Default)]
pub(super) struct Holds(Vec<(String, bool, oneshot::Receiver<()>)>);

impl Holds {
    pub(super) fn reply(&mut self, user: &str, after_tool: bool) -> ReplyGate {
        let (send, receive) = oneshot::channel();
        self.0.push((user.into(), after_tool, receive));
        ReplyGate(Some(send))
    }

    pub(super) fn take(&mut self, key: &MatchKey) -> Option<oneshot::Receiver<()>> {
        let index = self.0.iter().position(|(user, after_tool, _)| {
            key.user_request.contains(user)
                && (!after_tool || key.round.iter().any(|kind| kind == "function_call_output"))
        })?;
        Some(self.0.remove(index).2)
    }
}
