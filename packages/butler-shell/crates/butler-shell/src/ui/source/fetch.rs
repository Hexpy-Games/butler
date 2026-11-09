//! The page data pattern every screen shares (settings sections, management pages): one client
//! call on the agent worker per read, the page re-rendering only when its data changed, a
//! [`Load`] for what the read left, [`Flight`] for reads that must not pile up, and the one
//! timer page code waits on ([`sleep`], [`poll_every`]).
use std::time::Duration;

use butler_ds::ui::blocks::settings_section::SettingsSectionState;
use butler_shell_client::{Error, ShellClient};
use gpui::{AsyncApp, Context, Task};
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::ui::source::agent::Jobs;

/// A page's own fetch; `state` maps it to the DS section state.
pub(crate) enum Load<T> {
    Loading,
    Ready(T),
    Failed,
}

impl<T> Load<T> {
    pub(crate) fn state(&self, empty: impl Fn(&T) -> bool) -> SettingsSectionState {
        match self {
            Self::Loading => SettingsSectionState::Loading,
            Self::Failed => SettingsSectionState::Error,
            Self::Ready(value) if empty(value) => SettingsSectionState::Empty,
            Self::Ready(_) => SettingsSectionState::Ready,
        }
    }
}

/// One client call on the agent worker; `done` runs on the page with the decoded result, then
/// the page re-renders. No agent attached: `Err(Error::Connection)`; an answer that does not
/// decode: `Err(Error::Protocol)`. `Error::LocalMetadata` from an admin call is React's
/// `admin_credential_required`; `Error::Http(status)` carries the refusal's status.
pub(crate) fn fetch<P: 'static, T: DeserializeOwned + 'static, F, Fut>(
    cx: &mut Context<P>,
    call: F,
    done: impl FnOnce(&mut P, Result<T, Error>, &mut Context<P>) + 'static,
) where
    F: FnOnce(ShellClient) -> Fut + Send + 'static,
    Fut: Future<Output = Result<Value, Error>> + Send + 'static,
{
    fetch_if(cx, call, move |page, result, cx| {
        done(page, result, cx);
        true
    });
}

/// [`fetch`] for polls and live refetches: `done` returns whether the page's data changed, and
/// the page re-renders only then, so an unchanged answer wakes no window draw.
pub(crate) fn fetch_if<P: 'static, T: DeserializeOwned + 'static, F, Fut>(
    cx: &mut Context<P>,
    call: F,
    done: impl FnOnce(&mut P, Result<T, Error>, &mut Context<P>) -> bool + 'static,
) where
    F: FnOnce(ShellClient) -> Fut + Send + 'static,
    Fut: Future<Output = Result<Value, Error>> + Send + 'static,
{
    let request = Jobs::run(cx, call);
    cx.spawn(async move |this, cx| {
        let result = match request.await {
            Some(Ok(raw)) => serde_json::from_value(raw).map_err(|_| Error::Protocol),
            Some(Err(error)) => Err(error),
            None => Err(Error::Connection),
        };
        let _ = this.update(cx, |this, cx| {
            if done(this, result, cx) {
                cx.notify();
            }
        });
    })
    .detach();
}

/// `singleFlight` (canonEvents.ts:38): one read at a time; a change during a read runs exactly
/// one more afterwards, so a burst of events cannot queue reads that are all discarded.
#[allow(dead_code, reason = "seam API: the P4 units use it; F6 removes this")]
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct Flight {
    running: bool,
    dirty: bool,
}

#[allow(dead_code, reason = "seam API: the P4 units use it; F6 removes this")]
impl Flight {
    /// A read is wanted: true when it may start now; false while one runs (that one then runs
    /// once more).
    pub(crate) fn begin(&mut self) -> bool {
        if self.running {
            self.dirty = true;
            return false;
        }
        self.running = true;
        self.dirty = false;
        true
    }

    /// The read ended: true when one more must run now (the flight stays open for it).
    pub(crate) fn end(&mut self) -> bool {
        if self.dirty {
            self.dirty = false;
            return true;
        }
        self.running = false;
        false
    }
}

/// The only timer page code waits on (data polls, debounces). It wakes no window by itself: a
/// poll re-renders only through [`fetch_if`] when its answer changed.
// It becomes `butler_ds::ui::motion::sleep` when gpui-perf's branch lands (its source-check
// bans `background_executor().timer` outside the motion module).
pub(crate) fn sleep(cx: &AsyncApp, duration: Duration) -> Task<()> {
    let executor = cx.background_executor().clone();
    let timer = executor.clone();
    executor.spawn(async move { butler_ds::ui::motion::sleep(&timer, duration).await })
}

/// Runs `tick` on the page every `period` until the page or the returned task is dropped
/// (React's `setInterval` data polls: schedules 5 s, dashboard 30 s). `tick` reads with
/// [`fetch_if`], so an unchanged answer draws nothing.
#[allow(dead_code, reason = "seam API: the P4 polls use it; F6 removes this")]
pub(crate) fn poll_every<P: 'static>(
    cx: &mut Context<P>,
    period: Duration,
    tick: impl Fn(&mut P, &mut Context<P>) + 'static,
) -> Task<()> {
    cx.spawn(async move |this, cx| {
        loop {
            sleep(cx, period).await;
            if this.update(cx, |page, cx| tick(page, cx)).is_err() {
                return;
            }
        }
    })
}
