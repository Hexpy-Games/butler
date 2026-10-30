use super::*;
use butler_platform::hook_process::{HookProcess, run};
use futures_util::future::join_all;
use std::{
    collections::HashSet,
    time::{Duration, Instant},
};
fn matched(hooks: &Hooks, payload: &HookEnvelope) -> Vec<HookDefinition> {
    let mut seen = HashSet::new();
    hooks
        .state
        .read()
        .settings
        .config
        .hooks
        .iter()
        .chain(hooks.plugins.hooks().iter())
        .filter(|h| {
            h.event == payload.hook_event_name && h.matches(payload.payload.tool_name.as_deref())
        })
        .filter(|h| {
            seen.insert((
                h.id.split_once('/').map(|(plugin, _)| plugin.to_owned()),
                h.command.clone(),
                h.args.clone(),
                h.url.clone(),
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
) -> Result<Option<String>, String> {
    let handlers = matched(hooks, &payload);
    let sync = handlers
        .iter()
        .filter(|h| !h.asynchronous)
        .map(|h| execute(hooks, h, &payload, cancel.clone()));
    let reasons: Vec<String> = join_all(sync)
        .await
        .into_iter()
        .filter_map(|r| r.reason)
        .collect();
    for hook in handlers.into_iter().filter(|h| h.asynchronous) {
        let hooks = hooks.clone();
        let payload = payload.clone();
        let cancel = cancel.clone();
        tokio::spawn(async move {
            let permit = tokio::select! {
                permit = hooks.pool.clone().acquire_owned() => permit.ok(),
                () = hooks.shutdown.cancelled() => None,
                () = cancel.cancelled() => None,
            };
            let Some(_permit) = permit else {
                return;
            };
            Box::pin(execute(&hooks, &hook, &payload, cancel)).await;
        });
    }
    Ok((!reasons.is_empty()).then(|| reasons.join("\n")))
}
/// Transport result before the run record is assembled.
pub(super) struct Finished {
    pub(super) outcome: String,
    pub(super) reason: Option<String>,
    pub(super) exit_code: Option<i32>,
    pub(super) http_status: Option<u16>,
    pub(super) stdout: String,
    pub(super) stderr: String,
}
async fn execute(
    hooks: &Hooks,
    hook: &HookDefinition,
    payload: &HookEnvelope,
    cancel: CancellationToken,
) -> HookRun {
    let start = Instant::now();
    let finished = if hook.kind == "http" {
        super::http::run(hooks, hook, payload, cancel).await
    } else {
        command(hooks, hook, payload, cancel).await
    };
    if finished.outcome == "approval_ignored" {
        tracing::info!(event = "approval_ignored", hook_id = %hook.id, scope = if hook.id.contains('/') { "plugin" } else { "user" });
    }
    let record = HookRun {
        time: chrono::Utc::now().to_rfc3339(),
        hook_id: hook.id.clone(),
        event: hook.event,
        session_id: payload.session_id.clone(),
        outcome: finished.outcome,
        reason: finished.reason,
        exit_code: finished.exit_code,
        http_status: finished.http_status,
        duration_ms: u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX),
        stdout: excerpt(&finished.stdout),
        stderr: excerpt(&finished.stderr),
    };
    hooks.record(record.clone());
    record
}
async fn command(
    hooks: &Hooks,
    hook: &HookDefinition,
    payload: &HookEnvelope,
    cancel: CancellationToken,
) -> Finished {
    let prepared = prepare_input(hooks, hook, payload).await;
    let (input, redact) = match prepared {
        Ok((i, r)) => (Ok(i), r),
        Err(e) => (Err(e), Vec::new()),
    };
    let result = match input {
        Ok(input) => {
            let mut future = Box::pin(run(input, cancel.clone()));
            tokio::select! {
                result = &mut future => result,
                () = hooks.shutdown.cancelled() => { cancel.cancel(); future.await },
            }
        }
        Err(error) => Err(error),
    };
    let (outcome, reason) = super::decision::resolve(hook, &result);
    let clean = |text: &str| {
        let mut text = text.to_owned();
        for value in &redact {
            if !value.is_empty() {
                text = text.replace(value, "[redacted]");
            }
        }
        text
    };
    Finished {
        outcome,
        reason: reason.map(|s| clean(&s)),
        exit_code: result.as_ref().ok().and_then(|o| o.exit_code),
        http_status: None,
        stdout: result
            .as_ref()
            .ok()
            .map(|o| clean(&o.stdout))
            .unwrap_or_default(),
        stderr: result
            .as_ref()
            .map(|o| clean(&o.stderr))
            .unwrap_or_else(ToString::to_string),
    }
}
fn environment(
    hooks: &Hooks,
    hook: &HookDefinition,
    payload: &HookEnvelope,
) -> HashMap<String, String> {
    let mut env = hooks.environment.clone();
    env.extend(hook.env.clone());
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
    Ok(Box::pin(execute(hooks, &hook, &payload, cancel)).await)
}

/// The JSON envelope plus hook identity: command stdin and HTTP request body.
pub(super) fn body(hook: &HookDefinition, payload: &HookEnvelope) -> serde_json::Result<Vec<u8>> {
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
    serde_json::to_vec(&Body {
        envelope: payload,
        hook: Identity {
            id: &hook.id,
            scope: if hook.id.contains('/') {
                "plugin"
            } else {
                "user"
            },
        },
    })
}

fn input(
    hooks: &Hooks,
    hook: &HookDefinition,
    payload: &HookEnvelope,
) -> Result<HookProcess, butler_platform::hook_process::HookProcessError> {
    let stdin = body(hook, payload)
        .map_err(|e| butler_platform::hook_process::HookProcessError::Process(e.to_string()))?;
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
    Ok(HookProcess {
        command: hook.command.clone(),
        args,
        environment: environment(hooks, hook, payload),
        cwd: PathBuf::from(&payload.cwd),
        stdin,
        timeout: Duration::from_millis(hook.timeout_ms),
    })
}

async fn prepare_input(
    hooks: &Hooks,
    hook: &HookDefinition,
    payload: &HookEnvelope,
) -> Result<(HookProcess, Vec<String>), butler_platform::hook_process::HookProcessError> {
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
    .map_err(|_| {
        butler_platform::hook_process::HookProcessError::Process("plugin_task_failed".into())
    })?
    .map_err(|e| butler_platform::hook_process::HookProcessError::Process(e.code.into()))?;
    let mut payload = payload.clone();
    payload.cwd = cwd.to_string_lossy().into_owned();
    Ok((input(hooks, &hook, &payload)?, redact))
}
