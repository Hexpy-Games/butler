//! User-authored lifecycle command hooks and their process ports.
mod config;
mod context;
mod event;
mod project;
pub use config::{HookConfig, HookDefinition, HookMatcher};
pub use context::{HookContext, HookDispatched};
pub use event::{HookAttachment, HookEnvelope, HookEvent, HookPayload, HookToolError};
pub use project::{
    PROJECT_HOOK_FILE, PROJECT_HOOK_ID_PREFIX, PROJECT_HOOKS_CAPABILITY, ProjectHookAnswer,
    ProjectHookLine, ProjectHookRequest, ProjectHookReview,
};
use serde::{Deserialize, Serialize};
use std::{future::Future, pin::Pin};
/// Asynchronous hook operation; errors are safe for Settings display.
pub type HookFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, String>> + Send + 'a>>;
/// Current user registry with optimistic concurrency and reload diagnostics.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HookSettings {
    /// Monotonic process revision.
    pub revision: u64,
    /// Validated active configuration.
    pub config: HookConfig,
    /// Last invalid file error; the previous registry stays active.
    pub error: Option<String>,
}
/// One bounded in-memory run record.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HookRun {
    /// ISO timestamp.
    pub time: String,
    /// User hook id.
    pub hook_id: String,
    /// Lifecycle event.
    pub event: HookEvent,
    /// Session, absent for a synthetic test.
    pub session_id: Option<String>,
    /// continue, deny, error, timeout or approval_ignored.
    pub outcome: String,
    /// Decision or process failure explanation.
    pub reason: Option<String>,
    /// Process exit code, absent on signal or spawn failure.
    pub exit_code: Option<i32>,
    /// Elapsed milliseconds.
    pub duration_ms: u64,
    /// Bytes of output this run added to its turn's context.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_bytes: Option<u64>,
    /// At most 4 KiB of stdout for diagnostics.
    pub stdout: String,
    /// At most 4 KiB of stderr for diagnostics.
    pub stderr: String,
}
/// Process-owned dispatcher, shared by gateway and turn execution.
pub trait HookPort: Send + Sync {
    /// Atomic fast path: no matching event means no payload serialization.
    fn enabled(&self, event: HookEvent, tool: Option<&str>) -> bool;
    /// Atomic event-only fast path before resolving a progressive tool identity.
    fn event_enabled(&self, event: HookEvent) -> bool;
    /// Stat at admission boundaries; only changed files are read.
    fn reload(&self) -> HookFuture<'_, ()>;
    /// Run matching handlers and return their decisions in config order.
    fn dispatch(
        &self,
        payload: HookEnvelope,
        cancel: tokio_util::sync::CancellationToken,
    ) -> HookFuture<'_, HookDispatched>;
    /// Read registry and reload diagnostics.
    fn settings(&self) -> HookSettings;
    /// Atomically save a revision-checked user configuration.
    fn save(&self, revision: u64, config: HookConfig) -> HookFuture<'_, HookSettings>;
    /// Run a real handler against a synthetic payload, without a session.
    fn test(
        &self,
        id: String,
        cancel: tokio_util::sync::CancellationToken,
    ) -> HookFuture<'_, HookRun>;
    /// Snapshot of the last 200 runs, oldest first.
    fn runs(&self) -> Vec<HookRun>;
    /// Reads a project's hook file once and compares it with the user's answers:
    /// in the folder `session_id` works in, otherwise in `project_dir`.
    fn review_project(
        &self,
        _project_dir: String,
        _session_id: Option<String>,
    ) -> HookFuture<'_, ProjectHookReview> {
        Box::pin(async { Ok(ProjectHookReview::None) })
    }
    /// Remembers the user's answer for exactly this content.
    fn decide_project(&self, _request: ProjectHookRequest, _allowed: bool) -> HookFuture<'_, ()> {
        Box::pin(async { Ok(()) })
    }
    /// The saved answers about project folders, by path.
    fn project_answers(&self) -> HookFuture<'_, Vec<ProjectHookAnswer>> {
        Box::pin(async { Ok(Vec::new()) })
    }
    /// Forgets the answer about the folder at `path`, so its question comes back.
    /// Clearing only ever removes: it can never trust a folder.
    fn clear_project_answer(&self, _path: String) -> HookFuture<'_, ()> {
        Box::pin(async { Ok(()) })
    }
    /// Keeps a SessionStart that could not run yet because its hooks wait for an answer.
    fn hold_session_start(&self, _envelope: HookEnvelope) {}
    /// Ends a session's hold. A port holding allowed project hooks runs them for the
    /// held event, in the session's access mode now; any other port drops it.
    fn release_session_start(
        &self,
        _session_id: String,
        _access_mode: String,
        _cancel: tokio_util::sync::CancellationToken,
    ) -> HookFuture<'_, ()> {
        Box::pin(async { Ok(()) })
    }
}
