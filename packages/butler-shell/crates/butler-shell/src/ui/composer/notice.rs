//! `GitDependencyNotice` + `GitDependencyNoticePresenter`.
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::notice::{Notice, NoticeTone};
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::context::{Ds, Lang};
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::icon_button::IconButton;
use butler_ds::ui::layout::{Cross, Justify, Space, Stack};
use gpui::{AnyElement, App, ClickEvent, IntoElement as _, ParentElement as _, Window};

use crate::ui::i18n::composer::words;
use crate::ui::source::wire::SessionSummaryView;

const GIT_INSTALL_URL: &str = "https://git-scm.com/downloads";

/// `shouldShowGitDependencyNotice`.
pub(crate) fn git_missing(summary: Option<&SessionSummaryView>) -> bool {
    summary
        .and_then(|summary| summary.branch_info.as_ref())
        .and_then(|branch| branch.safe_error_code.as_deref())
        == Some("git_not_installed")
}

/// `GitDependencyNotice`: the warning above the card until the owner dismisses it. `missing` is
/// [`git_missing`] of the open chat's summary; `dismissed` lasts for the running app.
pub(super) fn git_dependency_notice(
    missing: bool,
    dismissed: bool,
    lang: Lang,
    on_dismiss: impl Fn(&mut Window, &mut App) + 'static,
    cx: &App,
) -> Option<AnyElement> {
    if !missing || dismissed {
        return None;
    }
    let copy = words(lang);
    let ds = Ds::get(cx);
    let install = Button::new("git-install")
        .size(Size::Sm)
        .variant(Variant::Outline)
        .text(copy.git_action)
        .on_click(|_: &ClickEvent, _, cx| cx.open_url(GIT_INSTALL_URL));
    let close = IconButton::new("git-dismiss", copy.git_dismiss)
        .icon(icon(Icon::X, IconSize::Md, ds))
        .on_click(move |_: &ClickEvent, window, cx| on_dismiss(window, cx));
    let action = Stack::row()
        .cross(Cross::Center)
        .gap(Space::Xs)
        .justify(Justify::End)
        .wrap(true)
        .child(install)
        .child(close);
    Some(
        Notice::new(NoticeTone::Warning, copy.git_message)
            .title(copy.git_title)
            .icon(icon(Icon::CircleAlert, IconSize::Lg, ds))
            .action(action)
            .into_any_element(),
    )
}
