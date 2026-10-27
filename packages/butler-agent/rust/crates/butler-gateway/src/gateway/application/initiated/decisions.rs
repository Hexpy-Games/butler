//! Serializes conversation-panel decisions across connected devices.
pub(in crate::gateway::application) type Decisions = std::sync::Arc<tokio::sync::Mutex<()>>;
