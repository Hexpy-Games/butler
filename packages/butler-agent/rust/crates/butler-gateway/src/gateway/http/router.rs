//! This table selects both transport templates and authenticated dispatch.
mod dispatch;
mod select;
use super::{HttpState, dispatch as dispatch_request};
use axum::{
    Extension, Router,
    body::Body,
    http::{Method, Request},
    routing::any,
};
pub(super) use dispatch::route;
use std::sync::Arc;

/// The request falls through every named route to the installed UI page (see `router/dispatch.rs`).
pub(super) fn serves_ui(request: &Request<Body>) -> bool {
    *request.method() == Method::GET && select::handler(request).is_none()
}

#[derive(Clone, Copy)]
pub(super) enum Handler {
    NotFound,
    ImageModels,
    #[cfg(feature = "e2e-fixtures")]
    ImageFixtures,
    DataReset,
    Authority,
    PendingAsks,
    Automations,
    Browser,
    BrowserStills,
    Cancel,
    Controls,
    Artifacts,
    Chats,
    Connect,
    ConnectionCodes,
    Events,
    Health,
    InternalSessionBranches,
    InternalSubsessionResult,
    Messages,
    NewChatBriefing,
    ProjectSessions,
    Projects,
    ProjectFolders,
    ProviderQuota,
    RuntimeReadiness,
    SessionQueue,
    Sessions,
    Skills,
    SkillsImport,
    TranscriptExport,
    Turns,
    Dashboard,
    Favicons,
    History,
    Hooks,
    Plugins,
    Library,
    Publishing,
    Documents,
    Live,
    Logs,
    Mcp,
    Computers,
    RemoteAccount,
    MessageFiles,
    MessageUpload,
    Models,
    Monitors,
    OpenedFiles,
    Operation,
    Output,
    Personalization,
    Preview,
    ProjectSession,
    Queue,
    Retry,
    Security,
    Settings,
    Setup,
    Shell,
    Space,
    Subsessions,
    TaskGraphs,
    Canon,
    CanonSidebar,
    Updates,
    Wallpapers,
    #[cfg(feature = "e2e-fixtures")]
    Expire,
    #[cfg(feature = "e2e-fixtures")]
    LogWriter,
}
impl Handler {
    pub(super) fn action(self, method: &axum::http::Method) -> Option<&'static str> {
        use axum::http::Method;
        match (self, method) {
            (Self::Messages, &Method::POST) => Some("message.send"),
            (Self::Cancel, &Method::POST) => Some("turn.cancel"),
            (Self::Retry, &Method::POST) => Some("turn.retry"),
            (Self::Controls, &Method::PATCH) => Some("session.controls"),
            _ => None,
        }
    }
}
pub(super) fn routes() -> Router<Arc<HttpState>> {
    let mut router = Router::new();
    for (path, handler) in table() {
        router = router.route(path, any(dispatch_request).layer(Extension(handler)));
    }
    router.fallback(any(dispatch_request))
}
#[cfg(feature = "test-support")]
pub(crate) fn templates() -> Vec<&'static str> {
    table().map(|(path, _)| path).collect()
}

fn table() -> impl Iterator<Item = (&'static str, Handler)> {
    let routes = super::routes::ROUTES
        .iter()
        .copied()
        .chain(super::canon_sidebar::ROUTES.iter().copied());
    #[cfg(feature = "e2e-fixtures")]
    let routes = routes.chain(FIXTURE_ROUTES.iter().copied());
    routes
}
#[cfg(feature = "e2e-fixtures")]
const FIXTURE_ROUTES: &[(&str, Handler)] = &[
    ("/internal/e2e/logs/expire", Handler::Expire),
    ("/internal/e2e/images/{action}", Handler::ImageFixtures),
    ("/internal/e2e/logs/writer/{action}", Handler::LogWriter),
    (
        "/automations/_test/scheduler-next-due-reads",
        Handler::Automations,
    ),
    (
        "/automations/_test/scheduler-dispatch-attempts",
        Handler::Automations,
    ),
];
