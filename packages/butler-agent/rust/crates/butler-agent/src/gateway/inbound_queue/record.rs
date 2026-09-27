//! Disk record shapes use the existing Bun queue field names.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::json::JsonDocument;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProcessingLease {
    pub claim_id: String,
    pub owner_id: String,
    pub claimed_at: String,
    pub lease_expires_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct QueuedInboundEvent {
    pub version: u8,
    pub queue_id: String,
    pub envelope: JsonDocument,
    pub enqueued_at: String,
    pub attempts: u64,
    #[serde(default)]
    pub metadata: Map<String, Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub processing: Option<ProcessingLease>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Clone, Debug)]
pub(crate) struct ClaimedInboundEvent {
    pub record: QueuedInboundEvent,
    pub path: PathBuf,
    pub processing: ProcessingLease,
}
