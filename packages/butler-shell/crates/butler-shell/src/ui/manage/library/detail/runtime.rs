//! What React keeps in module-level stores for the 서랍 (`libraryDialogs`'s store, `libraryDrop`'s
//! `before`, `libraryChanged`): the window's `ManageCtx` and the dialog host, reachable from the
//! free functions the seam names. The shell installs them once ([`install`]).
use gpui::{App, AppContext as _, Entity, Global};

use super::dialogs::{LibraryDialog, LibraryDialogs};
use crate::ui::manage::{ManageCtx, Topic, View};

#[derive(Default)]
struct Runtime {
    ctx: Option<ManageCtx>,
    dialogs: Option<Entity<LibraryDialogs>>,
    /// `libraryDrop.before`: the view a dwell left.
    before: Option<View>,
}

impl Global for Runtime {}

/// Called once by the shell at start-up: the window's `ManageCtx` and the dialog host, which the
/// shell renders (see [`dialog_host`]).
pub(crate) fn install(ctx: &ManageCtx, cx: &mut App) {
    let host = cx.new(|_| LibraryDialogs::new(ctx.clone()));
    let runtime = cx.default_global::<Runtime>();
    runtime.ctx = Some(ctx.clone());
    runtime.dialogs = Some(host);
}

/// The window's dialog host: the shell renders it; the 서랍 page listens to it.
pub(crate) fn dialog_host(cx: &App) -> Option<Entity<LibraryDialogs>> {
    cx.try_global::<Runtime>()?.dialogs.clone()
}

pub(super) fn ctx(cx: &App) -> Option<ManageCtx> {
    cx.try_global::<Runtime>()?.ctx.clone()
}

/// `libraryChanged()`: every list of the 서랍 reads again.
pub(super) fn changed(cx: &mut App) {
    if let Some(ctx) = ctx(cx) {
        ctx.live
            .update(cx, |live, cx| live.bump(Topic::Library, cx));
    }
}

/// `useLibraryDialogs.setState`: opens a dialog on the host.
pub(crate) fn open_dialog(dialog: LibraryDialog, cx: &mut App) {
    let Some(host) = dialog_host(cx) else {
        return;
    };
    host.update(cx, |host, cx| host.open(dialog, cx));
}

pub(super) fn remember_view(view: View, cx: &mut App) {
    cx.default_global::<Runtime>().before = Some(view);
}

pub(super) fn take_view(cx: &mut App) -> Option<View> {
    cx.default_global::<Runtime>().before.take()
}
