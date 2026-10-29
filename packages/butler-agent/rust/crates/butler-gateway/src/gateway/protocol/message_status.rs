//! Persisted message status values and the retry action exposed to clients.
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MessageStatus {
    Pending,
    Sent,
    Thinking,
    Streaming,
    Delivered,
    Failed,
    Retrying,
    Cancelled,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RetryMode {
    Resume,
    Fresh,
}
