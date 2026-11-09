//! The App package updater (`app-package-update.mjs`, `app-foreground-update.mjs`): open a
//! staged package through the Agent's installer, and the choice when work is active.
//!
//! The coordinator keeps Electron's states. A request reads the active work: with none it
//! installs, with some it asks (`ChoiceRequired`); a deferred update installs once the work
//! settles, woken by [`work_changed`] from the live events the shell already has.
mod apply;
mod copy;
mod package;

use std::time::Duration;

use butler_ds::ui::context::Ds;
use butler_ds::ui::toast::{self, Toast, ToastId};
use butler_shell_client::ShellClient;
use futures::channel::oneshot;
use gpui::{App, AppContext as _, AsyncApp, Context, Entity, Global, SharedString, Task};
use serde_json::{Value, json};

pub(crate) use self::apply::apply;
pub(crate) use self::copy::dialog_words;
use self::copy::words;
use self::package::{Helper, Package};
use super::supervisor::{AgentState, StopReason};
use crate::ui::source::agent::Jobs;

/// Where an App update stands (the sidebar row reads it).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) enum AppUpdateStatus {
    #[default]
    Idle,
    /// Work is active: install now or later; the request id.
    ChoiceRequired(SharedString),
    Deferred,
    Preparing,
    Restarting,
    Failed,
}

/// `AppUpdateCoordinator`'s state.
#[derive(Default)]
pub(crate) struct AppUpdate {
    status: AppUpdateStatus,
    package: Option<Package>,
    /// A request is deciding (`this.pending`); a deferred update is not pending.
    pending: bool,
    choice: Option<oneshot::Sender<bool>>,
    checking: bool,
    dirty: bool,
    debounce: Option<Task<()>>,
    toast: Option<ToastId>,
}

struct GlobalAppUpdate(Entity<AppUpdate>);

impl Global for GlobalAppUpdate {}

/// The coordinator, for views that re-render when the status changes.
pub(crate) fn entity(cx: &mut App) -> Entity<AppUpdate> {
    if let Some(global) = cx.try_global::<GlobalAppUpdate>() {
        return global.0.clone();
    }
    let entity = cx.new(|_| AppUpdate::default());
    cx.set_global(GlobalAppUpdate(entity.clone()));
    entity
}

pub(crate) fn status(cx: &App) -> AppUpdateStatus {
    cx.try_global::<GlobalAppUpdate>()
        .map(|global| global.0.read(cx).status.clone())
        .unwrap_or_default()
}

/// The work an update would interrupt (`readActiveWork`).
#[derive(Clone, Copy, PartialEq, Eq)]
enum Work {
    Idle,
    Active,
    Unknown,
}

enum Outcome {
    Deferred,
    Started,
}

impl AppUpdate {
    /// `AppUpdateDialog`'s toasts: a deferred and a failed update.
    fn announce(&mut self, cx: &mut Context<Self>) {
        let copy = words(Ds::get(cx).lang());
        let toast = match self.status {
            AppUpdateStatus::Deferred => Toast::message(copy.deferred),
            AppUpdateStatus::Failed => Toast::error(copy.apply_failed),
            _ => return,
        };
        let toast = match self.toast {
            Some(id) => toast.id(id),
            None => toast,
        };
        self.toast = Some(toast::show(cx, toast));
    }
}

/// Installs the staged package (`updates/staged/app.json`) and restarts into it.
pub(crate) fn open_staged(staged: &Value, cx: &mut App) -> Task<Result<(), SharedString>> {
    let entity = entity(cx);
    let Some(data) = super::runtime(cx).map(|runtime| runtime.read(cx).data.clone()) else {
        return Task::ready(Err(SharedString::from("The App is not running an Agent.")));
    };
    let package = match Package::locate(staged, &data) {
        Ok(package) => package,
        Err(failure) => return Task::ready(Err(failure)),
    };
    let busy = {
        let state = entity.read(cx);
        state.pending
            || matches!(
                state.status,
                AppUpdateStatus::Deferred
                    | AppUpdateStatus::Preparing
                    | AppUpdateStatus::Restarting
            )
    };
    if busy {
        return Task::ready(Ok(()));
    }
    entity.update(cx, |state, _| {
        state.pending = true;
        state.package = Some(package);
    });
    cx.spawn(async move |cx| {
        let result = begin(&entity, cx).await;
        entity.update(cx, |state, _| {
            state.choice = None;
            state.pending = false;
        });
        result
    })
}

/// The answer to a choice: install `now`, or when the App is idle.
pub(crate) fn choose(request_id: &str, now: bool, cx: &mut App) {
    entity(cx).update(cx, |state, _| {
        if let AppUpdateStatus::ChoiceRequired(id) = &state.status
            && id.as_ref() == request_id
            && let Some(answer) = state.choice.take()
        {
            let _ = answer.send(now);
        }
    });
}

/// A committed event may have settled the work: a deferred update looks again (after 100 ms of
/// quiet, as `watchAppUserWork` debounces).
pub(crate) fn work_changed(cx: &mut App) {
    let entity = entity(cx);
    if entity.read(cx).status != AppUpdateStatus::Deferred {
        return;
    }
    let target = entity.clone();
    let timer = cx.spawn(async move |cx| {
        butler_ds::ui::motion::sleep(cx.background_executor(), Duration::from_millis(100)).await;
        cx.spawn(async move |cx| check_deferred(&target, cx).await)
            .detach();
    });
    entity.update(cx, |state, _| state.debounce = Some(timer));
}

async fn publish(entity: &Entity<AppUpdate>, status: AppUpdateStatus, cx: &mut AsyncApp) {
    let failed = status == AppUpdateStatus::Failed;
    entity.update(cx, |state, cx| {
        state.status = status;
        state.announce(cx);
        cx.notify();
    });
    if failed {
        let _ = report_stage(cx, "failed").await;
    }
}

async fn fail(
    entity: &Entity<AppUpdate>,
    cx: &mut AsyncApp,
    code: &'static str,
) -> Result<Outcome, SharedString> {
    publish(entity, AppUpdateStatus::Failed, cx).await;
    Err(SharedString::from(code))
}

/// `begin`: ask when work is active, otherwise install.
async fn begin(entity: &Entity<AppUpdate>, cx: &mut AsyncApp) -> Result<(), SharedString> {
    match read_work(cx).await {
        Work::Unknown => {
            return fail(entity, cx, "update_work_state_unavailable")
                .await
                .map(|_| ());
        }
        Work::Active => {
            let (send, receive) = oneshot::channel();
            let request = uuid::Uuid::new_v4().to_string();
            entity.update(cx, |state, _| state.choice = Some(send));
            publish(entity, AppUpdateStatus::ChoiceRequired(request.into()), cx).await;
            if !receive.await.unwrap_or(false) {
                publish(entity, AppUpdateStatus::Deferred, cx).await;
                let target = entity.clone();
                cx.spawn(async move |cx| check_deferred(&target, cx).await)
                    .detach();
                return Ok(());
            }
        }
        Work::Idle => {}
    }
    install(entity, false, cx).await.map(|_| ())
}

/// `install`: verify and prepare the helper, stop the Agent with a checkpoint, then activate
/// the helper and quit so it can swap the package in.
async fn install(
    entity: &Entity<AppUpdate>,
    wait_for_work: bool,
    cx: &mut AsyncApp,
) -> Result<Outcome, SharedString> {
    publish(entity, AppUpdateStatus::Preparing, cx).await;
    let package = entity.update(cx, |state, _| state.package.clone());
    let Some(package) = package else {
        return fail(entity, cx, "update_package_missing").await;
    };
    let helper = match prepare(&package, cx).await {
        Ok(helper) => helper,
        Err(failure) => {
            publish(entity, AppUpdateStatus::Failed, cx).await;
            return Err(failure);
        }
    };
    if wait_for_work && read_work(cx).await != Work::Idle {
        helper.cancel();
        publish(entity, AppUpdateStatus::Deferred, cx).await;
        return Ok(Outcome::Deferred);
    }
    publish(entity, AppUpdateStatus::Restarting, cx).await;
    if let Err(failure) = stop_for_update(cx).await {
        helper.cancel();
        publish(entity, AppUpdateStatus::Failed, cx).await;
        return Err(failure);
    }
    helper.activate();
    cx.update(|app| app.quit());
    Ok(Outcome::Started)
}

/// `prepareAppPackageUpdate`: staged manifest, checksum, then the ready helper.
async fn prepare(package: &Package, cx: &mut AsyncApp) -> Result<Helper, SharedString> {
    let expected = package.staged_sha256()?;
    report_stage(cx, "verifying").await?;
    package.check_sha256(expected, cx).await?;
    let helper = package.start_helper(cx).await?;
    if let Err(failure) = report_stage(cx, "ready").await {
        helper.abort();
        return Err(failure);
    }
    Ok(helper)
}

/// `checkDeferred`: while deferred and idle, install; wake again on the next work change.
async fn check_deferred(entity: &Entity<AppUpdate>, cx: &mut AsyncApp) {
    let proceed = entity.update(cx, |state, _| {
        state.dirty = true;
        let go = !state.checking && state.status == AppUpdateStatus::Deferred;
        state.checking |= go;
        go
    });
    if !proceed {
        return;
    }
    loop {
        let again = entity.update(cx, |state, _| {
            let again = state.dirty && state.status == AppUpdateStatus::Deferred;
            state.dirty = false;
            again
        });
        if !again {
            break;
        }
        if read_work(cx).await != Work::Idle {
            continue;
        }
        match install(entity, true, cx).await {
            Ok(Outcome::Deferred) => {
                entity.update(cx, |state, _| state.dirty = true);
            }
            Ok(Outcome::Started) => {}
            Err(_) => {
                publish(entity, AppUpdateStatus::Failed, cx).await;
                break;
            }
        }
    }
    entity.update(cx, |state, _| {
        state.checking = false;
        if state.status != AppUpdateStatus::Deferred {
            state.pending = false;
        }
    });
}

/// `readForegroundActiveWorkSnapshot`: a stopped Agent has no work; a failed read is not "idle".
async fn read_work(cx: &AsyncApp) -> Work {
    let stopped = cx.update(|app| {
        super::runtime(app).is_some_and(|runtime| runtime.read(app).state == AgentState::Stopped)
    });
    if stopped {
        return Work::Idle;
    }
    let snapshot = call(cx, |client| async move { client.get_user_work().await }).await;
    let Some(Ok(snapshot)) = snapshot else {
        return Work::Unknown;
    };
    match snapshot.get("classification").and_then(Value::as_str) {
        Some("no_active_work") => Work::Idle,
        Some("active_work_detected") => Work::Active,
        _ => Work::Unknown,
    }
}

/// `stopForUpdate`: the Agent checkpoints its work and stops (an end-of-lease stop with the
/// update intent).
async fn stop_for_update(cx: &AsyncApp) -> Result<(), SharedString> {
    let checkpoint = || SharedString::from("update_checkpoint_failed");
    let Some(Ok(snapshot)) = call(cx, |client| async move { client.get_updates().await }).await
    else {
        return Err(checkpoint());
    };
    if snapshot["progress"]["stage"].as_str() == Some("ready") {
        report_stage(cx, "applying").await?;
        report_stage(cx, "restarting").await?;
    }
    let stopped = cx.update(|app| {
        super::runtime(app).map(|runtime| runtime.read(app).supervisor.stop(StopReason::Update))
    });
    match stopped {
        Some(answer) => match answer.await {
            Ok(Ok(())) => {
                cx.background_executor()
                    .spawn(async { super::logs::quit() })
                    .await;
                Ok(())
            }
            _ => Err(checkpoint()),
        },
        None => Err(checkpoint()),
    }
}

/// `reportAppUpdateStage`: POST /updates/progress
async fn report_stage(cx: &AsyncApp, stage: &'static str) -> Result<(), SharedString> {
    let sent = call(cx, move |client| async move {
        client.set_update_progress(&json!({ "stage": stage })).await
    })
    .await;
    match sent {
        Some(Ok(_)) => Ok(()),
        _ => Err(SharedString::from(
            "Update progress could not be delivered.",
        )),
    }
}

/// Runs `work` with the current client; `None` when no Agent is attached.
async fn call<T, F, Fut>(cx: &AsyncApp, work: F) -> Option<T>
where
    T: Send + 'static,
    F: FnOnce(ShellClient) -> Fut + Send + 'static,
    Fut: Future<Output = T> + Send + 'static,
{
    cx.update(|app| Jobs::run(app, work)).await
}
