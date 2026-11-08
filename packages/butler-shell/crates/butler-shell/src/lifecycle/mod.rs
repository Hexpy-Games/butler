//! The App's side of the Agent (`main.mjs` app wiring, `app/agentRuntime.ts`): where the data
//! lives, the supervisor that starts and stops the child Agent, the runtime state every window
//! reads, and quit. The supervisor never hands clients to the UI: `watch.rs` keeps discovering
//! whichever Agent is ready (our child, a CLI-started Agent or an external replacement).
pub(crate) mod app_update;
pub(crate) mod logs;
pub(crate) mod reset;
pub(crate) mod setup;
pub(crate) mod supervisor;
pub(crate) mod tray;
pub(crate) mod window;

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use futures::StreamExt as _;
use futures::channel::oneshot;
use gpui::{App, AppContext as _, Context, Entity, Global};

use supervisor::{AgentState, AgentStatus, Requester, StopReason, Supervisor, SupervisorError};

/// A supervisor command's answer.
pub(crate) type Answer = oneshot::Receiver<Result<(), SupervisorError>>;

/// The data folder: `--data`, then `BUTLER_DATA`, then `<home>/.butler` (the rule `watch.rs`
/// and the client follow).
pub(crate) fn data_root(args: &[OsString]) -> PathBuf {
    args.windows(2)
        .find(|pair| pair[0] == "--data")
        .map(|pair| PathBuf::from(&pair[1]))
        .or_else(|| {
            std::env::var_os("BUTLER_DATA")
                .filter(|path| !path.is_empty())
                .map(PathBuf::from)
        })
        .or_else(|| {
            butler_platform::user_dirs::non_empty_home_dir().map(|home| home.join(".butler"))
        })
        .unwrap_or_else(|| PathBuf::from(".butler"))
}

/// `unsupportedLegacyData` (app-legacy-data.mjs): a pre-BTCC data folder the Agent refuses, read
/// only (the App starts no Agent and writes nothing there).
pub(crate) fn legacy_data(data: &Path) -> bool {
    data.join("app-server")
        .join("butler-client.sqlite")
        .exists()
        && !data.join("agent-runtime").join("btcc.sqlite").exists()
}

/// The App's view of the Agent (`agentState()` and the supervisor's last error).
pub(crate) struct AgentRuntime {
    pub(crate) state: AgentState,
    pub(crate) requested_by: Option<Requester>,
    pub(crate) error: Option<SupervisorError>,
    /// Quit is running: every window shows the quit card in place of its frame.
    pub(crate) quitting: bool,
    pub(crate) data: PathBuf,
    pub(crate) legacy: bool,
    pub(crate) supervisor: Supervisor,
}

impl AgentRuntime {
    /// A status pushed by the supervisor; windows re-render only when it differs.
    fn apply(&mut self, status: &AgentStatus, cx: &mut Context<Self>) {
        if self.state == status.state
            && self.requested_by == status.requested_by
            && self.error == status.error
        {
            return;
        }
        self.state = status.state;
        self.requested_by = status.requested_by;
        self.error = status.error;
        cx.notify();
    }
}

struct GlobalAgentRuntime(Entity<AgentRuntime>);

impl Global for GlobalAgentRuntime {}

/// The runtime, once [`init`] ran (the app; the shot harness has none).
pub(crate) fn runtime(cx: &App) -> Option<Entity<AgentRuntime>> {
    cx.try_global::<GlobalAgentRuntime>()
        .map(|global| global.0.clone())
}

/// [`start`], the last-window rule and the tray (not for a legacy data folder, whose only screen
/// is the recovery notice).
pub(crate) fn init(cx: &mut App, data: PathBuf, legacy: bool) {
    start(cx, data, legacy);
    cx.on_window_closed(|cx, _| window::closed(cx)).detach();
    if !legacy {
        tray::init(cx);
    }
}

/// The runtime global, the supervisor and the crash hook, and the lease release on a forced
/// quit: the App's hold on its Agent, without the window and tray rules.
pub(crate) fn start(cx: &mut App, data: PathBuf, legacy: bool) {
    logs::install_crash_hook(&data);
    let (supervisor, mut statuses) = Supervisor::start(data.clone(), legacy);
    let entity = cx.new(|_| AgentRuntime {
        state: AgentState::Idle,
        requested_by: None,
        error: None,
        quitting: false,
        data,
        legacy,
        supervisor,
    });
    cx.set_global(GlobalAgentRuntime(entity.clone()));
    let weak = entity.downgrade();
    cx.spawn(async move |cx| {
        while let Some(status) = statuses.next().await {
            if weak
                .update(cx, |runtime, cx| runtime.apply(&status, cx))
                .is_err()
            {
                return;
            }
        }
    })
    .detach();
    // A forced OS quit still releases the lease: the Agent drains and exits by itself.
    cx.on_app_quit(|cx| {
        if let Some(entity) = runtime(cx) {
            entity.read(cx).supervisor.release_lease_now();
        }
        async {}
    })
    .detach();
}

/// Electron `ensureServer` at startup and the boot screen's Try again.
pub(crate) fn ensure_ready(cx: &mut App) {
    command(cx, Supervisor::ensure_ready);
}

/// Runs a supervisor command (resume, restart, repair, ensure ready) and folds its answer into
/// [`AgentRuntime::error`].
pub(crate) fn command(cx: &mut App, run: impl FnOnce(&Supervisor) -> Answer) {
    let Some(entity) = runtime(cx) else {
        return;
    };
    let answer = run(&entity.read(cx).supervisor);
    let weak = entity.downgrade();
    cx.spawn(async move |cx| {
        let Ok(result) = answer.await else {
            return;
        };
        let error = result.err();
        let _ = weak.update(cx, |runtime, cx| {
            if runtime.error != error {
                runtime.error = error;
                cx.notify();
            }
        });
    })
    .detach();
}

/// `before-quit` (main.mjs:2774-2816): every window shows the quit card, the child Agent stops
/// (end of its lease, a kill after 8 s), then the App exits. The App never asks about active
/// work; the Agent owns that.
pub(crate) fn quit(cx: &mut App) {
    let Some(entity) = runtime(cx) else {
        cx.quit();
        return;
    };
    if entity.read(cx).quitting {
        return;
    }
    entity.update(cx, |runtime, cx| {
        runtime.quitting = true;
        cx.notify();
    });
    let stop = entity.read(cx).supervisor.stop(StopReason::Quit);
    cx.spawn(async move |cx| {
        let _ = stop.await;
        cx.background_executor().spawn(async { logs::quit() }).await;
        cx.update(|cx| cx.quit());
    })
    .detach();
}
