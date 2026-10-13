//! What a reviewed schedule create sets up, for the approval card: its name,
//! when it runs and the run mode. Never the schedule id.
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApprovalSchedule {
    /// The title the schedule will get (the prompt when no title is given).
    pub title: String,
    pub schedule_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interval_seconds: Option<i64>,
    /// The exact reviewed run mode.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub access_mode: Option<String>,
}

/// Mirrors how the App endpoint stores a `create_automation` input.
pub(in crate::btcc::authority) fn schedule(input: &Value) -> ApprovalSchedule {
    let text = |key: &str| {
        input[key]
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    };
    let schedule_type = text("schedule_type").unwrap_or_default();
    ApprovalSchedule {
        title: text("title").or_else(|| text("prompt")).unwrap_or_default(),
        interval_seconds: (schedule_type == "interval").then(|| {
            input["interval_minutes"]
                .as_i64()
                .unwrap_or(0)
                .saturating_mul(60)
        }),
        schedule_type,
        run_at: text("run_at"),
        start_at: text("start_at"),
        access_mode: text("access_mode"),
    }
}
