use super::*;
use butler_platform::hook_process::{
    CONTEXT_OUTPUT_LIMIT, HookContainment, HookOutput, HookProcess, HookProcessError, HookSandbox,
    OUTPUT_LIMIT, run,
};
use futures_util::future::join_all;
use std::{
    collections::HashSet,
    time::{Duration, Instant},
};
/// A review's hooks and the folder they were reviewed in.
pub(super) struct ProjectScope<'a> {
    pub(super) hooks: &'a [HookDefinition],
    pub(super) root: Arc<str>,
}

fn matched(
    hooks: &Hooks,
    payload: &HookEnvelope,
    project: &[HookDefinition],
) -> Vec<HookDefinition> {
    let mut seen = HashSet::new();
    hooks
        .state
        .read()
        .settings
        .config
        .hooks
        .iter()
        .chain(hooks.plugins.hooks().iter())
        .chain(project)
        .filter(|h| {
            h.event == payload.hook_event_name && h.matches(payload.payload.tool_name.as_deref())
        })
        .filter(|h| {
            seen.insert((
                h.id.split_once('/').map(|(plugin, _)| plugin.to_owned()),
                h.command.clone(),
                h.args.clone(),
                h.env.clone(),
                h.timeout_ms,
                h.fail_closed,
                h.asynchronous,
            ))
        })
        .cloned()
        .collect()
}
pub(super) async fn dispatch(
    hooks: &Arc<Hooks>,
    payload: HookEnvelope,
    cancel: CancellationToken,
    project: Option<ProjectScope<'_>>,
) -> Result<HookDispatched, String> {
    let definitions = project.as_ref().map_or(&[][..], |scope| scope.hooks);
    let handlers = matched(hooks, &payload, definitions);
    let root = project.map(|scope| scope.root);
    Ok(run_handlers(hooks, handlers, payload, cancel, root).await)
}

/// Runs these handlers for the event: joined deny reasons in order, and added text.
pub(super) async fn run_handlers(
    hooks: &Arc<Hooks>,
    handlers: Vec<HookDefinition>,
    payload: HookEnvelope,
    cancel: CancellationToken,
    root: Option<Arc<str>>,
) -> HookDispatched {
    let sync = handlers
        .iter()
        .filter(|h| !h.asynchronous)
        .map(|h| execute(hooks, h, &payload, cancel.clone(), root.as_deref()));
    let mut reasons = Vec::new();
    let mut context = Vec::new();
    let mut project_denied = false;
    for done in join_all(sync).await {
        project_denied |= done.project_denied;
        reasons.extend(done.deny);
        context.extend(done.context);
    }
    for hook in handlers.into_iter().filter(|h| h.asynchronous) {
        let hooks = hooks.clone();
        let payload = payload.clone();
        let cancel = cancel.clone();
        let root = root.clone();
        tokio::spawn(async move {
            let permit = tokio::select! {
                permit = hooks.pool.clone().acquire_owned() => permit.ok(),
                () = hooks.shutdown.cancelled() => None,
                () = cancel.cancelled() => None,
            };
            let Some(_permit) = permit else {
                return;
            };
            Box::pin(execute(&hooks, &hook, &payload, cancel, root.as_deref())).await;
        });
    }
    HookDispatched {
        deny: (!reasons.is_empty()).then(|| reasons.join("\n")),
        context,
        project_denied,
    }
}
/// One handler's run and what it means for its event.
struct Executed {
    run: HookRun,
    deny: Option<String>,
    context: Option<HookContext>,
    /// `deny` carries words from the project folder.
    project_denied: bool,
}
async fn execute(
    hooks: &Hooks,
    hook: &HookDefinition,
    payload: &HookEnvelope,
    cancel: CancellationToken,
    root: Option<&str>,
) -> Executed {
    let start = Instant::now();
    // A project hook runs where it was reviewed, whichever folder raised the event.
    let reviewed = root
        .filter(|_| hook.id.starts_with(PROJECT_HOOK_ID_PREFIX))
        .map(|root| HookEnvelope {
            project_dir: Some(root.to_owned()),
            cwd: root.to_owned(),
            ..payload.clone()
        });
    let payload = reviewed.as_ref().unwrap_or(payload);
    let prepared = prepare_input(hooks, hook, payload).await;
    let (input, redact) = match prepared {
        Ok((i, r)) => (Ok(i), r),
        Err(e) => (Err(e), Vec::new()),
    };
    let result = match input {
        Ok(input) => run_process(hooks, input, cancel).await,
        Err(error) => Err(error),
    };
    let (outcome, reason) = super::decision::resolve(hook, &result);
    if outcome == "approval_ignored" {
        tracing::info!(event = "approval_ignored", hook_id = %hook.id, scope = scope(hook));
    }
    let reason = reason.map(|s| clean(&s, &redact));
    let exit_code = result.as_ref().ok().and_then(|o| o.exit_code);
    let stdout = result
        .as_ref()
        .ok()
        .map(|o| clean(&o.stdout, &redact))
        .unwrap_or_default();
    let overflow = match &result {
        Err(error @ HookProcessError::OutputLimit(_)) => Some(error.to_string()),
        _ => None,
    };
    let added = super::context::added(
        hooks,
        hook,
        payload,
        super::context::Finished {
            outcome: &outcome,
            exit_code,
            stdout: &stdout,
            redact: &redact,
            overflow,
        },
    )
    .await;
    let record = HookRun {
        time: chrono::Utc::now().to_rfc3339(),
        hook_id: hook.id.clone(),
        event: hook.event,
        session_id: payload.session_id.clone(),
        outcome,
        reason: reason.clone().or(added.note),
        exit_code,
        duration_ms: u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX),
        context_bytes: added.bytes,
        stdout: excerpt(&stdout),
        stderr: result
            .as_ref()
            .map(|o| excerpt(&clean(&o.stderr, &redact)))
            .unwrap_or_else(ToString::to_string),
    };
    hooks.record(record.clone());
    Executed {
        run: record,
        project_denied: reason.is_some() && scope(hook) == "project",
        deny: reason,
        context: added.context,
    }
}
pub(super) fn clean(text: &str, redact: &[String]) -> String {
    let mut text = text.to_owned();
    for value in redact {
        if !value.is_empty() {
            text = text.replace(value, "[redacted]");
        }
    }
    text
}
pub(super) fn scope(hook: &HookDefinition) -> &'static str {
    if hook.id.contains('/') {
        "plugin"
    } else if hook.id.starts_with(PROJECT_HOOK_ID_PREFIX) {
        "project"
    } else {
        "user"
    }
}
async fn run_process(
    hooks: &Hooks,
    input: HookProcess,
    cancel: CancellationToken,
) -> Result<HookOutput, HookProcessError> {
    let mut future = Box::pin(run(input, cancel.clone()));
    tokio::select! {
        result = &mut future => result,
        () = hooks.shutdown.cancelled() => { cancel.cancel(); future.await },
    }
}
/// What a hook's own process gets: what its file names, then who it is.
fn own_environment(hook: &HookDefinition, payload: &HookEnvelope) -> HashMap<String, String> {
    let mut env: HashMap<String, String> = hook.env.clone().into_iter().collect();
    env.insert("BUTLER_HOOK".into(), "1".into());
    env.insert("BUTLER_HOOK_ID".into(), hook.id.clone());
    env.insert("BUTLER_HOOK_EVENT".into(), format!("{:?}", hook.event));
    env.insert(
        "BUTLER_SESSION_ID".into(),
        payload.session_id.clone().unwrap_or_default(),
    );
    env.insert(
        "BUTLER_PROJECT_DIR".into(),
        payload.project_dir.clone().unwrap_or_default(),
    );
    env
}
fn excerpt(text: &str) -> String {
    let end = (0..=text.len().min(4096))
        .rev()
        .find(|i| text.is_char_boundary(*i))
        .unwrap_or(0);
    text.get(..end).unwrap_or_default().to_owned()
}
pub(super) async fn test(
    hooks: &Arc<Hooks>,
    id: String,
    cancel: CancellationToken,
) -> Result<HookRun, String> {
    let hook = hooks
        .state
        .read()
        .settings
        .config
        .hooks
        .iter()
        .find(|h| h.id == id)
        .cloned()
        .ok_or("Hook not found")?;
    let payload = HookEnvelope {
        schema: "butler.hook.v1".into(),
        hook_event_name: hook.event,
        event_id: format!("evt_test_{}", uuid::Uuid::new_v4()),
        occurred_at: chrono::Utc::now().to_rfc3339(),
        session_id: None,
        turn_id: None,
        parent_session_id: None,
        project_dir: None,
        cwd: hooks.home.to_string_lossy().into_owned(),
        access_mode: None,
        payload: HookPayload {
            source: Some("created".into()),
            prompt: Some("Hook test".into()),
            attachments: Some(Vec::new()),
            tool_name: Some("run_command".into()),
            tool_use_id: Some("test".into()),
            tool_input: Some(serde_json::Map::new()),
            resumed: Some(false),
            ok: Some(true),
            last_assistant_message: Some("Hook test".into()),
            stop_hook_active: Some(false),
            ..HookPayload::default()
        },
    };
    Ok(Box::pin(execute(hooks, &hook, &payload, cancel, None))
        .await
        .run)
}

fn input(
    hooks: &Hooks,
    hook: &HookDefinition,
    payload: &HookEnvelope,
) -> Result<HookProcess, HookProcessError> {
    #[derive(serde::Serialize)]
    struct Identity<'a> {
        id: &'a str,
        scope: &'static str,
    }
    #[derive(serde::Serialize)]
    struct Body<'a> {
        #[serde(flatten)]
        envelope: &'a HookEnvelope,
        hook: Identity<'a>,
    }
    let stdin = serde_json::to_vec(&Body {
        envelope: payload,
        hook: Identity {
            id: &hook.id,
            scope: scope(hook),
        },
    })
    .map_err(|e| HookProcessError::Process(e.to_string()))?;
    let args = hook.args.as_ref().map(|args| {
        args.iter()
            .map(|arg| {
                arg.replace(
                    "${BUTLER_PROJECT_DIR}",
                    payload.project_dir.as_deref().unwrap_or_default(),
                )
            })
            .collect()
    });
    let sandbox = sandbox(hooks, hook, payload);
    let own = own_environment(hook, payload);
    let mut environment = hooks.environment.clone();
    let sandbox_environment = if matches!(sandbox, HookSandbox::None) {
        environment.extend(own);
        HashMap::new()
    } else {
        own
    };
    Ok(HookProcess {
        command: hook.command.clone(),
        args,
        environment,
        sandbox_environment,
        cwd: PathBuf::from(&payload.cwd),
        stdin,
        timeout: Duration::from_millis(hook.timeout_ms),
        sandbox,
        stdout_limit: if super::context::can_add(hook) {
            CONTEXT_OUTPUT_LIMIT
        } else {
            OUTPUT_LIMIT
        },
    })
}

/// A project hook gets the sandbox of the session it runs for, in the folder it was
/// reviewed in: only full access is exempt, and a mode it cannot name gets the least.
fn sandbox(hooks: &Hooks, hook: &HookDefinition, payload: &HookEnvelope) -> HookSandbox {
    if !hook.id.starts_with(PROJECT_HOOK_ID_PREFIX) {
        return HookSandbox::None;
    }
    let mut policy_environment = hooks.environment.clone();
    policy_environment.insert(
        "BUTLER_DATA".into(),
        hooks.data.to_string_lossy().into_owned(),
    );
    // The Windows sandbox refuses a command without its deadline.
    policy_environment.insert(
        "BUTLER_COMMAND_TIMEOUT_MS".into(),
        hook.timeout_ms.to_string(),
    );
    let containment = HookContainment {
        policy_environment,
        root: PathBuf::from(&payload.cwd),
        data: hooks.data.clone(),
    };
    match payload.access_mode.as_deref() {
        Some("full_access") => HookSandbox::None,
        Some("auto" | "ask_first" | "ask_except_reads") => HookSandbox::ProjectWrite(containment),
        _ => HookSandbox::ReadOnly(containment),
    }
}

async fn prepare_input(
    hooks: &Hooks,
    hook: &HookDefinition,
    payload: &HookEnvelope,
) -> Result<(HookProcess, Vec<String>), HookProcessError> {
    if !hook.id.contains('/') {
        return input(hooks, hook, payload).map(|i| (i, Vec::new()));
    }
    let plugins = hooks.plugins.clone();
    let mut hook = hook.clone();
    let (hook, cwd, redact) = tokio::task::spawn_blocking(move || {
        let (cwd, redact) = plugins.hook_execution(&mut hook)?;
        Ok::<_, butler_core::plugins::PluginError>((hook, cwd, redact))
    })
    .await
    .map_err(|_| HookProcessError::Process("plugin_task_failed".into()))?
    .map_err(|e| HookProcessError::Process(e.code.into()))?;
    let mut payload = payload.clone();
    payload.cwd = cwd.to_string_lossy().into_owned();
    Ok((input(hooks, &hook, &payload)?, redact))
}
