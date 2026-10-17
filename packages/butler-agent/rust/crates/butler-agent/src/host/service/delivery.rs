//! App transport acknowledgement follows its actual durable transcript append.
//!
//! Every action enters the transcript after the progress committed before it:
//! App projection drops progress that arrives once its Turn has settled, and a
//! Turn commits its events before its outcome is delivered.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde_json::{Value, json};

use crate::host::ProgressPublisher;
use crate::host::service::ingress::{IngressDelivery, IngressError};

pub(in crate::host) struct AppDelivery {
    progress: Arc<ProgressPublisher>,
}

impl AppDelivery {
    pub(in crate::host) fn new(progress: Arc<ProgressPublisher>) -> Self {
        Self { progress }
    }
}

impl IngressDelivery for AppDelivery {
    fn deliver(
        &self,
        session_id: String,
        action: Value,
    ) -> Pin<Box<dyn Future<Output = Result<bool, IngressError>> + Send>> {
        let progress = self.progress.clone();
        Box::pin(async move {
            let timing = crate::host::guided::command::timing::CommandTiming::new("app_delivery");
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
            // Source App adapter acknowledges locally. Projection consumes the
            // durable outbound/delivery pair; no HTTP send is hidden here.
            let delivery = json!({"ok": true, "transportMessageId": format!("app:{action_id}")});
            progress
                .deliver(
                    session_id,
                    action,
                    delivery,
                    json!({"source":"transport/delivery-guard.ts","attempts":1}),
                )
                .await
                .map_err(|e| {
                    IngressError::new("native_progress_publication_failed", e.message())
                        .with_source(e)
                })?;
            timing.mark("transcript_committed");
            Ok(true)
        })
    }
}
