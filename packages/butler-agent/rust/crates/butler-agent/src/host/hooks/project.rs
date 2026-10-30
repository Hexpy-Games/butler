//! Project-folder hooks. The file is read once for each review; what that read
//! parsed is what gets hashed, shown on the card and run, and nothing reads the
//! file again until the next review. A file that is a symlink, or reached through
//! one, is refused, and so is one with an HTTP hook: those need a signing secret
//! from the user's own configuration.
use super::{Dispatcher, Hooks, execute, trust};
use butler_core::hooks::*;
use butler_platform::secure_fs;
use std::{
    io::{self, Read},
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio_util::sync::CancellationToken;

const CAP: u64 = 256 * 1024;
/// A folder name is cut after this many characters on the card.
const MAX_FOLDER_CHARS: usize = 80;

/// One read of a project's hook file.
struct ProjectFile {
    request: ProjectHookRequest,
    /// Every hook, ids prefixed for run records.
    hooks: Vec<HookDefinition>,
}

/// What a review found on disk.
enum Found {
    Nothing,
    File(Box<ProjectFile>, trust::Store),
}

/// A root's filesystem identity: a replaced folder has another one, even at the
/// same path with the same files.
fn folder_identity(root: &Path) -> io::Result<String> {
    let identity = secure_fs::identity(&std::fs::metadata(root)?);
    Ok(match (identity.id, identity.changed) {
        (Some(id), _) => format!("{}:{}", id.device, id.inode),
        (None, Some(created)) => format!("{}.{}", created.seconds, created.nanoseconds),
        (None, None) => String::new(),
    })
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
    if config.hooks.iter().any(|hook| hook.kind != "command") {
        return Err("Project hooks must be commands".into());
    }
    Ok(Some(config))
}

/// Control and invisible characters could hide part of a command on the card.
fn visible(text: &str) -> String {
    let mut shown = String::with_capacity(text.len());
    for character in text.chars() {
        match character {
            '\n' => shown.push_str("\\n"),
            '\r' => shown.push_str("\\r"),
            '\t' => shown.push_str("\\t"),
            '\u{ad}'
            | '\u{200b}'..='\u{200f}'
            | '\u{2028}'..='\u{202e}'
            | '\u{2060}'..='\u{206f}'
            | '\u{feff}' => shown.push_str(&format!("\\u{{{:x}}}", u32::from(character))),
            control if control.is_control() => {
                shown.push_str(&format!("\\u{{{:x}}}", u32::from(control)));
            }
            other => shown.push(other),
        }
    }
    shown
}

/// Quotes what a reader could otherwise split differently from the real argv.
fn quoted(argument: &str) -> String {
    let plain = !argument.is_empty()
        && argument
            .chars()
            .all(|c| c.is_alphanumeric() || "-_./:=@%+,".contains(c));
    if plain {
        argument.to_owned()
    } else {
        format!("'{}'", argument.replace('\'', "'\\''"))
    }
}

/// The exact action: environment additions first, as a shell would read them.
fn action(hook: &HookDefinition) -> String {
    let mut parts: Vec<String> = hook
        .env
        .iter()
        .map(|(key, value)| format!("{}={}", quoted(key), quoted(value)))
        .collect();
    match (&hook.command, &hook.args) {
        (Some(command), _) => parts.push(command.clone()),
        (None, Some(args)) => parts.extend(args.iter().map(|argument| quoted(argument))),
        (None, None) => {}
    }
    visible(&parts.join(" "))
}

fn line(hook: &HookDefinition) -> Result<ProjectHookLine, String> {
    let definition = serde_json::to_string(hook).map_err(|error| error.to_string())?;
    Ok(ProjectHookLine {
        id: hook.id.clone(),
        event: hook.event,
        tools: hook
            .matcher
            .tools
            .iter()
            .map(|tool| visible(tool))
            .collect(),
        command: action(hook),
        digest: butler_turn::btcc::digest_identity(&definition),
        change: None,
    })
}

fn folder_name(root: &Path) -> String {
    let name: String = root
        .file_name()
        .map(|name| name.to_string_lossy())
        .unwrap_or_default()
        .chars()
        .filter(|character| !character.is_control())
        .take(MAX_FOLDER_CHARS)
        .collect();
    visible(&name)
}

fn with_changes(
    mut lines: Vec<ProjectHookLine>,
    last_allowed: &[ProjectHookLine],
) -> Vec<ProjectHookLine> {
    if last_allowed.is_empty() {
        return lines;
    }
    for line in &mut lines {
        line.change = match last_allowed.iter().find(|old| old.id == line.id) {
            None => Some(ProjectHookChange::Added),
            Some(old) if old.digest != line.digest => Some(ProjectHookChange::Changed),
            Some(_) => None,
        };
    }
    let removed: Vec<ProjectHookLine> = last_allowed
        .iter()
        .filter(|old| !lines.iter().any(|line| line.id == old.id))
        .map(|old| ProjectHookLine {
            change: Some(ProjectHookChange::Removed),
            ..old.clone()
        })
        .collect();
    lines.extend(removed);
    lines
}

/// Hashes what was parsed, not the bytes: only a change in what would run asks again.
fn load(root: &Path, user_hooks: &Path, data: &Path) -> Result<Found, String> {
    let resolved = match secure_fs::canonicalize(root) {
        Ok(resolved) => resolved,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Found::Nothing),
        Err(error) => return Err(error.to_string()),
    };
    if secure_fs::canonicalize(resolved.join(PROJECT_HOOK_FILE)).is_ok_and(|file| {
        secure_fs::canonicalize(user_hooks).is_ok_and(|user_file| user_file == file)
    }) {
        return Ok(Found::Nothing); // The user's own file, whose project is its parent folder.
    }
    let before = folder_identity(&resolved).map_err(|error| error.to_string())?;
    let Some(config) = read_config(&resolved)? else {
        return Ok(Found::Nothing);
    };
    if folder_identity(&resolved).map_err(|error| error.to_string())? != before {
        return Err("Project folder changed while it was read".into());
    }
    if !config.hooks.iter().any(|hook| hook.enabled) {
        return Ok(Found::Nothing);
    }
    let parsed = serde_json::to_string(&config).map_err(|error| error.to_string())?;
    let path = resolved.to_string_lossy().into_owned();
    let content_hash =
        butler_turn::btcc::digest_identity(&format!("project-hooks\0{path}\0{before}\0{parsed}"));
    let lines = config.hooks.iter().filter(|hook| hook.enabled).map(line);
    let lines = lines.collect::<Result<Vec<_>, _>>()?;
    let store = trust::read(data);
    let last_allowed = store.last_allowed(&path, &before);
    let request = ProjectHookRequest {
        project_identity: before,
        content_hash,
        folder: folder_name(&resolved),
        file: PROJECT_HOOK_FILE.into(),
        changed: !last_allowed.is_empty(),
        hooks: with_changes(lines, last_allowed),
        project_path: path,
    };
    let hooks = config
        .hooks
        .into_iter()
        .map(|hook| HookDefinition {
            id: format!("{PROJECT_HOOK_ID_PREFIX}{}", hook.id),
            ..hook
        })
        .collect();
    Ok(Found::File(Box::new(ProjectFile { request, hooks }), store))
}

/// A refused file runs nothing, and says why in Settings' run log, once per reason.
fn report_refused(hooks: &Hooks, reason: String) {
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
        http_status: None,
        duration_ms: 0,
        stdout: String::new(),
        stderr: String::new(),
    });
}

pub(super) async fn review(
    hooks: &Arc<Hooks>,
    project_dir: String,
) -> Result<ProjectHookReview, String> {
    let root = PathBuf::from(project_dir);
    let user_hooks = hooks.path.clone();
    let data = hooks.data.clone();
    let found = tokio::task::spawn_blocking(move || load(&root, &user_hooks, &data))
        .await
        .map_err(|error| error.to_string())?;
    let (file, store) = match found {
        Ok(Found::File(file, store)) => (file, store),
        Ok(Found::Nothing) => return Ok(ProjectHookReview::None),
        Err(reason) => {
            report_refused(hooks, reason);
            return Ok(ProjectHookReview::None);
        }
    };
    Ok(match store.answer(&file.request) {
        Some(true) => ProjectHookReview::Trusted(Arc::new(Scoped::new(hooks, file.hooks))),
        Some(false) => ProjectHookReview::Denied,
        None => ProjectHookReview::Undecided(Box::new(file.request)),
    })
}

/// The dispatcher plus the hooks one review read; those never change afterwards.
struct Scoped {
    inner: Dispatcher,
    hooks: Vec<HookDefinition>,
}

impl Scoped {
    fn new(hooks: &Arc<Hooks>, definitions: Vec<HookDefinition>) -> Self {
        Self {
            inner: Dispatcher(hooks.clone()),
            hooks: definitions,
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
    ) -> HookFuture<'_, Option<String>> {
        Box::pin(execute::dispatch(
            &self.inner.0,
            payload,
            cancel,
            &self.hooks,
        ))
    }
    fn settings(&self) -> HookSettings {
        self.inner.settings()
    }
    fn save(
        &self,
        revision: u64,
        config: HookConfig,
        secrets: std::collections::BTreeMap<String, butler_platform::secrets::SecretText>,
    ) -> HookFuture<'_, HookSaved> {
        self.inner.save(revision, config, secrets)
    }
    fn test(&self, id: String, cancel: CancellationToken) -> HookFuture<'_, HookRun> {
        self.inner.test(id, cancel)
    }
    fn runs(&self) -> Vec<HookRun> {
        self.inner.runs()
    }
    fn review_project(&self, project_dir: String) -> HookFuture<'_, ProjectHookReview> {
        self.inner.review_project(project_dir)
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
        cancel: CancellationToken,
    ) -> HookFuture<'_, ()> {
        Box::pin(async move {
            let held = self.inner.0.held_starts.lock().remove(&session_id);
            if let Some(envelope) = held {
                let handlers = self
                    .hooks
                    .iter()
                    .filter(|hook| hook.event == envelope.hook_event_name && hook.enabled)
                    .cloned()
                    .collect();
                execute::run_handlers(&self.inner.0, handlers, envelope, cancel).await;
            }
            Ok(())
        })
    }
}
