//! App transport acknowledgement follows its actual durable transcript append.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde_json::{Value, json};

use crate::host::service::ingress::{IngressDelivery, IngressError};
use butler_gateway::gateway::TranscriptWriter;

use super::progress_publisher::ProgressPublisher;

pub(in crate::host) struct AppDelivery {
    writer: Arc<TranscriptWriter>,
    progress: Arc<ProgressPublisher>,
}

impl AppDelivery {
    pub(in crate::host) fn new(
        writer: Arc<TranscriptWriter>,
        progress: Arc<ProgressPublisher>,
    ) -> Self {
        Self { writer, progress }
    }
}

impl IngressDelivery for AppDelivery {
    fn deliver(
        &self,
        session_id: String,
        action: Value,
    ) -> Pin<Box<dyn Future<Output = Result<bool, IngressError>> + Send>> {
        let writer = self.writer.clone();
        let progress = self.progress.clone();
        Box::pin(async move {
            if action["transport"] != "app" {
                return Err(IngressError::new(
                    "native_transport_unavailable",
                    "Native transport unavailable",
                ));
            }
            let action_id = action["actionId"]
                .as_str()
                .filter(|id| !id.is_empty())
                .ok_or_else(|| {
                    IngressError::new(
                        "native_action_identity_missing",
                        "Action identity unavailable",
                    )
                })?;
            // Committed progress (streamed text included) is transcribed before
            // the action, so the App projects it while the turn is still open.
            // Pending events that fail here are retried by maintenance.
            let _ = progress.reconcile().await;
            // Source App adapter acknowledges locally. Projection consumes the
            // durable outbound/delivery pair; no HTTP send is hidden here.
            let delivery = json!({"ok": true, "transportMessageId": format!("app:{action_id}")});
            writer
                .append_outbound(
                    session_id,
                    action,
                    delivery,
                    json!({"source":"transport/delivery-guard.ts","attempts":1}),
                )
                .await
                .map_err(|e| IngressError::new(e.code(), e.message()))?;
            Ok(true)
        })
    }
}
