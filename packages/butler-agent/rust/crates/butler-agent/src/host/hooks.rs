//! Process-owned user hook registry; no workers, watchers or idle timers.
mod decision;
mod execute;
mod registry;
use butler_core::hooks::*;
use parking_lot::RwLock;
use std::{
    collections::{HashMap, VecDeque},
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicU8, Ordering},
    },
    time::SystemTime,
};
use tokio_util::sync::CancellationToken;
struct State {
    settings: HookSettings,
    stamp: Option<(SystemTime, u64)>,
    runs: VecDeque<HookRun>,
}
pub(crate) struct Dispatcher(Arc<Hooks>);
struct Hooks {
    path: PathBuf,
    home: PathBuf,
    environment: HashMap<String, String>,
    events: AtomicU8,
    state: RwLock<State>,
    mutation: tokio::sync::Mutex<()>,
    pool: Arc<tokio::sync::Semaphore>,
    shutdown: CancellationToken,
}
impl Dispatcher {
    pub(crate) async fn open(
        data: PathBuf,
        environment: &HashMap<String, String>,
        shutdown: CancellationToken,
    ) -> Self {
        let hooks = Arc::new(Hooks {
            path: data.join("hooks.json"),
            home: butler_platform::user_dirs::home_dir().unwrap_or_else(|| data.clone()),
            environment: butler_platform::command_sandbox::tool_environment(environment),
            events: AtomicU8::new(0),
            state: RwLock::new(State {
                settings: HookSettings {
                    revision: 0,
                    config: HookConfig {
                        version: 1,
                        hooks: Vec::new(),
                    },
                    error: None,
                },
                stamp: None,
                runs: VecDeque::new(),
            }),
            mutation: tokio::sync::Mutex::new(()),
            pool: Arc::new(tokio::sync::Semaphore::new(8)),
            shutdown,
        });
        let _ = registry::reload(&hooks).await;
        Self(hooks)
    }
}
impl Hooks {
    fn publish(&self, config: HookConfig) {
        let bits = config
            .hooks
            .iter()
            .filter(|h| h.enabled)
            .fold(0, |bits, h| bits | h.event.bit());
        let mut state = self.state.write();
        state.settings.config = config;
        state.settings.revision += 1;
        state.settings.error = None;
        self.events.store(bits, Ordering::Release);
    }
    fn record(&self, run: HookRun) {
        let mut state = self.state.write();
        if state.runs.len() == 200 {
            state.runs.pop_front();
        }
        state.runs.push_back(run);
    }
}
impl HookPort for Dispatcher {
    fn event_enabled(&self, event: HookEvent) -> bool {
        self.0.events.load(Ordering::Acquire) & event.bit() != 0
    }
    fn enabled(&self, event: HookEvent, tool: Option<&str>) -> bool {
        if self.0.events.load(Ordering::Acquire) & event.bit() == 0 {
            return false;
        }
        self.0
            .state
            .read()
            .settings
            .config
            .hooks
            .iter()
            .any(|h| h.event == event && h.matches(tool))
    }
    fn reload(&self) -> HookFuture<'_, ()> {
        Box::pin(registry::reload(&self.0))
    }
    fn settings(&self) -> HookSettings {
        self.0.state.read().settings.clone()
    }
    fn save(&self, revision: u64, config: HookConfig) -> HookFuture<'_, HookSettings> {
        Box::pin(registry::save(&self.0, revision, config))
    }
    fn dispatch(
        &self,
        payload: HookEnvelope,
        cancel: CancellationToken,
    ) -> HookFuture<'_, Option<String>> {
        Box::pin(execute::dispatch(&self.0, payload, cancel))
    }
    fn test(&self, id: String, cancel: CancellationToken) -> HookFuture<'_, HookRun> {
        Box::pin(execute::test(&self.0, id, cancel))
    }
    fn runs(&self) -> Vec<HookRun> {
        self.0.state.read().runs.iter().cloned().collect()
    }
}
