//! App transport acknowledgement follows its actual durable transcript append.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde_json::{Value, json};

use super::native_ingress::{NativeIngressDelivery, NativeIngressError};
use crate::gateway::NativeTranscriptWriter;

pub(super) struct NativeAppDelivery {
    writer: Arc<NativeTranscriptWriter>,
}

impl NativeAppDelivery {
    pub(super) fn new(writer: Arc<NativeTranscriptWriter>) -> Self {
        Self { writer }
    }
}

impl NativeIngressDelivery for NativeAppDelivery {
    fn deliver(
        &self,
        session_id: String,
        action: Value,
    ) -> Pin<Box<dyn Future<Output = Result<bool, NativeIngressError>> + Send>> {
        let writer = self.writer.clone();
        Box::pin(async move {
            if action["transport"] != "app" {
                return Err(NativeIngressError::new(
                    "native_transport_unavailable",
                    "Native transport unavailable",
                ));
            }
            let action_id = action["actionId"]
                .as_str()
                .filter(|id| !id.is_empty())
                .ok_or_else(|| {
                    NativeIngressError::new(
                        "native_action_identity_missing",
                        "Action identity unavailable",
                    )
                })?;
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
                .map_err(|e| NativeIngressError::new(e.code, e.message))?;
            Ok(true)
        })
    }
}
