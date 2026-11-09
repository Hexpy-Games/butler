//! `ProjectDashboardHeader`: the project's title and its New chat action.
pub(super) mod description;

use butler_ds::ui::Icon;
use butler_ds::ui::blocks::dashboard_header::DashboardHeader;
use butler_ds::ui::button::{self, Button, Size, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use gpui::ParentElement as _;
use gpui::{AnyElement, App, IntoElement as _, SharedString};

use super::copy::words;
use crate::ui::manage::Action;

/// The header; the actions show only for a known project (`project ?`).
pub(super) fn dashboard_header(
    title: SharedString,
    actions: Option<Action>,
    cx: &App,
) -> AnyElement {
    let ds = Ds::get(cx);
    let copy = words(ds.lang());
    let header = DashboardHeader::new(title);
    let Some(new_chat) = actions else {
        return header.into_any_element();
    };
    let chat = Button::new("dashboard-new-chat")
        .variant(Variant::Outline)
        .icon_start(icon(Icon::MessageSquarePlus, IconSize::Md, ds))
        .text(copy.new_chat)
        .on_click(move |_, window, cx| new_chat(window, cx));
    // CARVE-OUT(G-wall): React adds an overflow menu with "Wallpaper" (ProjectWallpaperDialog);
    // it is the menu's only item, so the menu is left out until the wallpaper engine lands.
    header
        .action(button::container(Size::Default).child(chat))
        .into_any_element()
}
