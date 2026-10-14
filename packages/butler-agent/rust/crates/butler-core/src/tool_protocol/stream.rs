//! Provider-independent, ordered tool argument observations. Never persist these payloads.
use serde::{Deserialize, Serialize};

/// Tool identity precedes argument fragments for each `(stream_id, call_index)`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ToolCallStreamEvent {
    /// The complete tool name is known; subsequent fragments belong to this call.
    ToolCallStart {
        /// Provider response identity (not a render key).
        stream_id: String,
        /// Call position within the response.
        call_index: u64,
        /// Monotonically increasing observation sequence.
        sequence: u64,
        /// Tool name, before any arguments are forwarded.
        tool_name: String,
    },
    /// An exact, ordered fragment of the call's JSON arguments.
    ToolCallDelta {
        /// Same response identity as the start.
        stream_id: String,
        /// Same call position as the start.
        call_index: u64,
        /// Monotonically increasing observation sequence.
        sequence: u64,
        /// Unmodified argument bytes represented as UTF-8 text.
        arguments_delta: String,
    },
}
