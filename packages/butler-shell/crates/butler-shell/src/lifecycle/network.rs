//! The machine's online state for the UI (`useOnlineStatus`): one global entity fed by
//! `butler_platform::network_status`, notifying only when the value flips.
use gpui::{App, AppContext as _, Entity, Global};

pub(crate) struct NetworkStatus {
    pub(crate) online: bool,
}

struct GlobalNetwork(Entity<NetworkStatus>);

impl Global for GlobalNetwork {}

/// Start the watcher and the entity. Called once at startup.
pub(crate) fn init(cx: &mut App) {
    let mut receiver = butler_platform::network_status::online();
    let status = cx.new(|_| NetworkStatus {
        online: *receiver.borrow_and_update(),
    });
    let weak = status.downgrade();
    cx.set_global(GlobalNetwork(status));
    cx.spawn(async move |cx| {
        while receiver.changed().await.is_ok() {
            let online = *receiver.borrow_and_update();
            let updated = weak.update(cx, |status, cx| {
                if status.online != online {
                    status.online = online;
                    cx.notify();
                }
            });
            if updated.is_err() {
                break;
            }
        }
    })
    .detach();
}

/// `navigator.onLine`; `true` before [`init`].
pub(crate) fn online(cx: &App) -> bool {
    entity(cx).is_none_or(|status| status.read(cx).online)
}

pub(crate) fn entity(cx: &App) -> Option<Entity<NetworkStatus>> {
    cx.try_global::<GlobalNetwork>()
        .map(|global| global.0.clone())
}
