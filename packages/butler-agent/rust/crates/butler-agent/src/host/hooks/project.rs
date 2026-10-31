//! Project-folder hooks. The file is read once for each review; what that read
//! parsed is what gets hashed, shown on the card and run, and nothing reads the
//! file again until the next review. A file that is a symlink, or reached through
//! one, is refused, and so is an invalid one.
use super::{Dispatcher, Hooks, execute, project_lines, trust};
use butler_core::hooks::*;
use butler_platform::secure_fs;
use std::{
    io::{self, Read},
    path::Path,
    sync::Arc,
};
use tokio_util::sync::CancellationToken;

const CAP: u64 = 256 * 1024;

/// One read of a project's hook file.
struct ProjectFile {
    request: ProjectHookRequest,
    /// The hooks that would run, ids prefixed for run records.
    hooks: Vec<HookDefinition>,
}

/// What a review found on disk.
enum Found {
    Nothing,
    File(Box<ProjectFile>, trust::Store),
}

/// A root's filesystem identity: a replaced folder has another one, even at the
/// same path with the same files. A folder without one cannot be answered for.
fn folder_identity(root: &Path) -> Result<String, String> {
    match secure_fs::directory_id(root).map_err(|error| error.to_string())? {
        Some(id) => Ok(format!("{}:{}", id.device, id.inode)),
        None => Err("Project folder has no filesystem identity".into()),
    }
}

fn read_config(root: &Path) -> Result<Option<HookConfig>, String> {
    let mut bytes = Vec::new();
    match secure_fs::open_read_beneath(root, Path::new(PROJECT_HOOK_FILE)) {
        Ok(file) => file
            .take(CAP + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| error.to_string())?,
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
            ) =>
        {
            return Ok(None);
        }
        Err(error) => return Err(error.to_string()),
    };
    if bytes.len() as u64 > CAP {
        return Err("Hook file exceeds 256 KiB".into());
    }
    let config: HookConfig = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    config.validate()?;
    Ok(Some(config))
}

/// One folder, as the review found it.
struct Folder {
    path: String,
    identity: String,
    location: String,
    name: String,
}

/// Hooks the user allowed can no longer run. That is a question only if they had
/// allowed some here: otherwise there was never anything to lose.
fn hooks_off(folder: Folder, off: ProjectHooksOff, store: trust::Store) -> Found {
    let last_allowed = store.last_allowed(&folder.path, &folder.identity);
    if last_allowed.is_empty() {
        return Found::Nothing;
    }
    let content_hash = butler_turn::btcc::digest_identity(&format!(
        "project-hooks-off\0{}\0{}\0{off:?}",
        folder.path, folder.identity
    ));
    let request = ProjectHookRequest {
        content_hash,
        folder: folder.name,
        file: PROJECT_HOOK_FILE.into(),
        location: folder.location,
        changed: true,
        unsandboxed: false,
        off: Some(off),
        hooks: project_lines::with_changes(Vec::new(), last_allowed),
        project_identity: folder.identity,
        project_path: folder.path,
    };
    let file = ProjectFile {
        request,
        hooks: Vec::new(),
    };
    Found::File(Box::new(file), store)
}

/// Hashes what would run, not the bytes: only a change in that asks again.
fn hooks_on(folder: Folder, config: &HookConfig, store: trust::Store) -> Result<Found, String> {
    let enabled = config.hooks.iter().filter(|hook| hook.enabled);
    let runnable: Vec<HookDefinition> = enabled.map(project_lines::runnable).collect();
    let parsed = serde_json::to_string(&runnable).map_err(|error| error.to_string())?;
    let content_hash = butler_turn::btcc::digest_identity(&format!(
        "project-hooks\0{}\0{}\0{parsed}",
        folder.path, folder.identity
    ));
    let lines = runnable.iter().map(project_lines::line);
    let lines = lines.collect::<Result<Vec<_>, _>>()?;
    let last_allowed = store.last_allowed(&folder.path, &folder.identity);
    let request = ProjectHookRequest {
        content_hash,
        folder: folder.name,
        file: PROJECT_HOOK_FILE.into(),
        location: folder.location,
        changed: !last_allowed.is_empty(),
        unsandboxed: false,
        off: None,
        hooks: project_lines::with_changes(lines, last_allowed),
        project_identity: folder.identity,
        project_path: folder.path,
    };
    let hooks = runnable
        .into_iter()
        .map(|hook| HookDefinition {
            id: format!("{PROJECT_HOOK_ID_PREFIX}{}", hook.id),
            ..hook
        })
        .collect();
    Ok(Found::File(Box::new(ProjectFile { request, hooks }), store))
}

/// What a read of the folder means, and the reason if the file had to be refused.
fn load(root: &Path, user_hooks: &Path, data: &Path) -> Result<(Found, Option<String>), String> {
    let resolved = match secure_fs::canonicalize(root) {
        Ok(resolved) => resolved,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok((Found::Nothing, None)),
        Err(error) => return Err(error.to_string()),
    };
    let file = resolved.join(PROJECT_HOOK_FILE);
    if secure_fs::canonicalize(&file).is_ok_and(|file| {
        secure_fs::canonicalize(user_hooks).is_ok_and(|user_file| user_file == file)
    }) {
        return Ok((Found::Nothing, None)); // The user's own file, in its parent folder.
    }
    let identity = folder_identity(&resolved)?;
    let config = read_config(&resolved);
    if folder_identity(&resolved)? != identity {
        return Err("Project folder changed while it was read".into());
    }
    let folder = Folder {
        path: resolved.to_string_lossy().into_owned(),
        identity,
        location: project_lines::visible(&file.to_string_lossy()),
        name: project_lines::folder_name(&resolved),
    };
    let store = trust::read(data);
    Ok(match config {
        Err(reason) => (
            hooks_off(folder, ProjectHooksOff::Refused, store),
            Some(reason),
        ),
        Ok(None) => (hooks_off(folder, ProjectHooksOff::Missing, store), None),
        Ok(Some(config)) if !config.hooks.iter().any(|hook| hook.enabled) => {
            (hooks_off(folder, ProjectHooksOff::Disabled, store), None)
        }
        Ok(Some(config)) => (hooks_on(folder, &config, store)?, None),
    })
}

/// A refused file runs nothing, and says why in Settings' run log, once per reason.
fn report_refused(hooks: &Hooks, reason: &str) {
    let reason = project_lines::safe_reason(reason);
    let hook_id = format!("{PROJECT_HOOK_ID_PREFIX}{PROJECT_HOOK_FILE}");
    let repeated = hooks
        .state
        .read()
        .runs
        .iter()
        .rev()
        .find(|run| run.hook_id == hook_id)
        .is_some_and(|run| run.reason.as_deref() == Some(reason.as_str()));
    if repeated {
        return;
    }
    tracing::warn!(event = "project_hooks_refused", reason = %reason);
    hooks.record(HookRun {
        time: chrono::Utc::now().to_rfc3339(),
        hook_id,
        event: HookEvent::SessionStart,
        session_id: None,
        outcome: "error".into(),
        reason: Some(reason),
        exit_code: None,
        duration_ms: 0,
        stdout: String::new(),
        stderr: String::new(),
    });
}

/// The folder a session works in, which a turn reviews too: its project's root
/// until the session moves to a worktree or another folder.
async fn session_folder(hooks: &Hooks, session_id: &str, project_dir: String) -> String {
    match hooks.bindings.get_by_session_id(session_id).await {
        Ok(Some(binding)) if !binding.workspace_path.is_empty() => binding.workspace_path,
        _ => project_dir,
    }
}

pub(super) async fn review(
    hooks: &Arc<Hooks>,
    project_dir: String,
    session_id: Option<String>,
) -> Result<ProjectHookReview, String> {
    let root = match session_id {
        Some(session) => session_folder(hooks, &session, project_dir).await,
        None => project_dir,
    };
    let user_hooks = hooks.path.clone();
    let data = hooks.data.clone();
    let found = tokio::task::spawn_blocking(move || load(Path::new(&root), &user_hooks, &data))
        .await
        .map_err(|error| error.to_string())?;
    let (found, refused) = match found {
        Ok(found) => found,
        Err(reason) => (Found::Nothing, Some(reason)),
    };
    if let Some(reason) = refused {
        report_refused(hooks, &reason);
    }
    let Found::File(file, store) = found else {
        return Ok(ProjectHookReview::None);
    };
    Ok(match store.answer(&file.request) {
        Some(true) => ProjectHookReview::Trusted(Arc::new(Scoped::new(hooks, *file))),
        Some(false) => ProjectHookReview::Denied,
        None => ProjectHookReview::Undecided(Box::new(file.request)),
    })
}

/// A held SessionStart runs after its turn's context was claimed, so what it prints
/// has no turn to join. Its side effects stand; the run log says the text was dropped.
fn record_dropped(hooks: &Hooks, session_id: &str, context: &[HookContext]) {
    for dropped in context {
        hooks.record(HookRun {
            time: chrono::Utc::now().to_rfc3339(),
            hook_id: dropped.hook.clone(),
            event: dropped.event,
            session_id: Some(session_id.to_owned()),
            outcome: "continue".into(),
            reason: Some("Added text was dropped: this hook waited for an answer".into()),
            exit_code: None,
            duration_ms: 0,
            context_bytes: None,
            stdout: String::new(),
            stderr: String::new(),
        });
    }
}

/// The dispatcher plus the hooks one review read; those never change afterwards.
struct Scoped {
    inner: Dispatcher,
    hooks: Vec<HookDefinition>,
    /// The reviewed folder: its hooks run there, wherever the event came from.
    root: Arc<str>,
}

impl Scoped {
    fn new(hooks: &Arc<Hooks>, file: ProjectFile) -> Self {
        Self {
            inner: Dispatcher(hooks.clone()),
            hooks: file.hooks,
            root: file.request.project_path.into(),
        }
    }
}

impl HookPort for Scoped {
    fn enabled(&self, event: HookEvent, tool: Option<&str>) -> bool {
        self.inner.enabled(event, tool)
            || self
                .hooks
                .iter()
                .any(|hook| hook.event == event && hook.matches(tool))
    }
    fn event_enabled(&self, event: HookEvent) -> bool {
        self.inner.event_enabled(event)
            || self
                .hooks
                .iter()
                .any(|hook| hook.event == event && hook.enabled)
    }
    fn reload(&self) -> HookFuture<'_, ()> {
        self.inner.reload()
    }
    fn dispatch(
        &self,
        payload: HookEnvelope,
        cancel: CancellationToken,
    ) -> HookFuture<'_, HookDispatched> {
        Box::pin(execute::dispatch(
            &self.inner.0,
            payload,
            cancel,
            Some(execute::ProjectScope {
                hooks: &self.hooks,
                root: self.root.clone(),
            }),
        ))
    }
    fn settings(&self) -> HookSettings {
        self.inner.settings()
    }
    fn save(&self, revision: u64, config: HookConfig) -> HookFuture<'_, HookSettings> {
        self.inner.save(revision, config)
    }
    fn test(&self, id: String, cancel: CancellationToken) -> HookFuture<'_, HookRun> {
        self.inner.test(id, cancel)
    }
    fn runs(&self) -> Vec<HookRun> {
        self.inner.runs()
    }
    fn review_project(
        &self,
        project_dir: String,
        session_id: Option<String>,
    ) -> HookFuture<'_, ProjectHookReview> {
        self.inner.review_project(project_dir, session_id)
    }
    fn decide_project(&self, request: ProjectHookRequest, allowed: bool) -> HookFuture<'_, ()> {
        self.inner.decide_project(request, allowed)
    }
    fn hold_session_start(&self, envelope: HookEnvelope) {
        self.inner.hold_session_start(envelope);
    }
    /// The user's own hooks already ran for this event: only the project's run now.
    fn release_session_start(
        &self,
        session_id: String,
        access_mode: String,
        cancel: CancellationToken,
    ) -> HookFuture<'_, ()> {
        Box::pin(async move {
            let held = self.inner.0.held_starts.lock().remove(&session_id);
            if let Some(mut envelope) = held {
                envelope.access_mode = Some(access_mode);
                let handlers = self
                    .hooks
                    .iter()
                    .filter(|hook| hook.event == envelope.hook_event_name && hook.enabled)
                    .cloned()
                    .collect();
                let root = Some(self.root.clone());
                let dispatched =
                    execute::run_handlers(&self.inner.0, handlers, envelope, cancel, root).await;
                record_dropped(&self.inner.0, &session_id, &dispatched.context);
            }
            Ok(())
        })
    }
}
