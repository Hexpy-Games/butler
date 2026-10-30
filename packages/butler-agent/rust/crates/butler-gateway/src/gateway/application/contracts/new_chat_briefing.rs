//! New Chat Briefing view port: the host projects Cognition's stored briefing.
use std::path::PathBuf;

use serde_json::Value;

use super::ApplicationFuture;

/// The project a project briefing is read for.
#[derive(Clone, Debug)]
pub struct AppBriefingProject {
    pub id: String,
    pub display_name: String,
}

/// The App state a New Chat Briefing view is projected with.
#[derive(Clone, Debug)]
pub struct AppNewChatBriefingRequest {
    pub data_root: PathBuf,
    pub date: Option<String>,
    /// The general briefing when absent.
    pub project: Option<AppBriefingProject>,
    pub locale: String,
    pub now: String,
}

pub trait AppNewChatBriefingPort: Send + Sync + 'static {
    fn view(&self, request: AppNewChatBriefingRequest) -> ApplicationFuture<Value>;
}

#[cfg(test)]
pub(crate) struct TestNewChatBriefing;

#[cfg(test)]
impl AppNewChatBriefingPort for TestNewChatBriefing {
    fn view(&self, _: AppNewChatBriefingRequest) -> ApplicationFuture<Value> {
        Box::pin(async { Err(crate::gateway::GatewayApplicationError::internal()) })
    }
}
