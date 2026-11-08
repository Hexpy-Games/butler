//! Models: management, add/edit and image models (`ModelManagementPage.tsx`,
//! `ModelAddEditPage.tsx`, `ImageModelsSettings.tsx` and what they compose). U05 calls
//! [`ManagementPage`], [`AddEditPage`] and [`ImageModels`].
//! Not ported: `ModelRouteFrame.tsx`'s slide-in (the settings shell animates a page by its key
//! and order), `ModelAuthTag`'s aria label (gpui has no slot for it).
mod add_edit;
mod card;
mod catalog;
mod copy;
mod credentials;
mod hosted;
mod image;
mod management;

use butler_ds::ui::toast::{self, Toast, ToastId};
use gpui::App;

pub(crate) use add_edit::AddEditPage;
pub(crate) use image::ImageModels;
pub(crate) use management::ManagementPage;

/// A toast with one of React's ids (`notifyStatus` / `notifyError` with `id`): it replaces the
/// last one this page showed.
fn notify(slot: &mut Option<ToastId>, toast: Toast, cx: &mut App) {
    let toast = match *slot {
        Some(id) => toast.id(id),
        None => toast,
    };
    *slot = Some(toast::show(cx, toast));
}
