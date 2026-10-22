//! Replay through App admission so the kept request has a real visible turn.
use super::*;
use crate::host::ActiveAppEndpoint;
use butler_turn::btcc::PortFuture;

pub(crate) struct AppSubsessionQueue {
    queue: SubsessionQueue,
    endpoint: Arc<ActiveAppEndpoint>,
    client: butler_log::http::Client,
}
impl AppSubsessionQueue {
    pub(crate) fn new(
        queue: Arc<InboundQueue>,
        endpoint: Arc<ActiveAppEndpoint>,
    ) -> Result<Self, BtccError> {
        let client = butler_log::http::loopback()
            .redirect(butler_log::http::RedirectPolicy::none())
            .build()
            .map_err(|e| invalid().with_source(e))?;
        Ok(Self {
            queue: SubsessionQueue(queue),
            endpoint,
            client,
        })
    }
    async fn replay(&self, event: String, receipt: String) -> Result<(), BtccError> {
        let queue = self.queue.0.clone();
        let envelope = tokio::task::spawn_blocking(move || {
            let lookup = JsonDocument::from_value(&json!({"eventId":event}))
                .map_err(|e| invalid().with_source(e))?;
            queue
                .find_idempotent(&lookup)
                .map_err(queue_error)?
                .ok_or_else(invalid)?
                .envelope
                .read::<Value>()
                .map_err(|e| invalid().with_source(e))
        })
        .await
        .map_err(|e| invalid().with_source(e))??;
        let mut changes = self.endpoint.subscribe_changes();
        let endpoint = loop {
            changes.borrow_and_update();
            if let Some(endpoint) = self.endpoint.snapshot() {
                break endpoint;
            }
            changes
                .changed()
                .await
                .map_err(|e| invalid().with_source(e))?;
        };
        let body = json!({"chat_id":envelope["peer"]["id"],"source_message_id":envelope["message"]["id"],"receipt_id":receipt});
        let mut request = self
            .client
            .post(format!(
                "{}/internal/work-cutover-replay",
                endpoint.base_url
            ))
            .header("content-type", "application/json")
            .body(body.to_string());
        if endpoint.local_auth.required {
            request = request.bearer_auth(endpoint.local_auth.token().ok_or_else(invalid)?);
        }
        let response = request.send().await.map_err(|e| invalid().with_source(e))?;
        if !response.status().is_success() {
            return Err(invalid());
        }
        Ok(())
    }
}
impl SubsessionChildQueue for AppSubsessionQueue {
    fn enqueue(&self, input: SubsessionEnqueue) -> Result<(), BtccError> {
        self.queue.enqueue(input)
    }
    fn replay_kept_request(&self, event: String, receipt: String) -> PortFuture<'_, ()> {
        Box::pin(self.replay(event, receipt))
    }
    fn interrupted_event(
        &self,
        event: &str,
        session: &str,
        turn: &str,
    ) -> Result<Option<InterruptedSubsessionEvent>, BtccError> {
        self.queue.interrupted_event(event, session, turn)
    }
}
