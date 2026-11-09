//! `ProjectDashboardHeader`: the project's title and its New chat action.
pub(super) mod description;

use butler_ds::ui::Icon;
use butler_ds::ui::blocks::dashboard_header::DashboardHeader;
use butler_ds::ui::blocks::overflow_action_menu::{OverflowActionMenu, OverflowItem};
use butler_ds::ui::button::{self, Button, Size, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::toast::{self, Toast};
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
    // CARVE-OUT(G-wall): the menu's only item, Wallpaper, opens ProjectWallpaperDialog; the
    // wallpaper engine is not ported, so selecting it shows the "coming soon" toast.
    let menu = OverflowActionMenu::new("dashboard-project-menu", copy.project_menu).item(
        OverflowItem::new(copy.wallpaper)
            .icon(Icon::ImageIcon)
            .on_select(move |_, cx| {
                toast::show(cx, Toast::message(copy.not_yet));
            }),
    );
    header
        .action(button::container(Size::Default).child(chat).child(menu))
        .into_any_element()
}
