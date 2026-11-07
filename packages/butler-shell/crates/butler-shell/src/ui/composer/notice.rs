//! `GitDependencyNotice` + `GitDependencyNoticePresenter`, and `ComposerCrashFallback`.
use std::cell::Cell;
use std::rc::Rc;

use butler_ds::ui::Icon;
use butler_ds::ui::blocks::composer_card::ComposerCard;
use butler_ds::ui::blocks::notice::{Notice, NoticeTone};
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::context::{Ds, Lang};
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::icon_button::IconButton;
use butler_ds::ui::layout::{Cross, Justify, Space, Stack};
use gpui::{AnyElement, App, ClickEvent, IntoElement as _, ParentElement as _, Window, canvas};
use gpui::{Styled as _, div};

use crate::ui::source::wire::SessionSummaryView;

const GIT_INSTALL_URL: &str = "https://git-scm.com/downloads";

/// The `composer` strings of the catalog and the `interfacePanels` ones.
struct Words {
    title: &'static str,
    message: &'static str,
    action: &'static str,
    dismiss: &'static str,
    crashed: &'static str,
    retry: &'static str,
}

const KO: Words = Words {
    title: "Git이 설치되어 있지 않습니다",
    message: "버틀러는 계속 사용할 수 있지만 브랜치와 커밋 기능은 사용할 수 없습니다.",
    action: "Git 설치 안내",
    dismiss: "Git 안내 닫기",
    crashed: "화면을 표시할 수 없습니다.",
    retry: "다시 시도",
};

const EN: Words = Words {
    title: "Git is not installed",
    message: "Butler still works, but branch and commit features are unavailable.",
    action: "Install Git",
    dismiss: "Dismiss Git notice",
    crashed: "Unable to show this view.",
    retry: "Retry",
};

fn copy(lang: Lang) -> &'static Words {
    match lang {
        Lang::Ko => &KO,
        Lang::En => &EN,
    }
}

/// `shouldShowGitDependencyNotice`.
#[allow(dead_code, reason = "wired by Opus at wave integration")]
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
    let copy = copy(lang);
    let ds = Ds::get(cx);
    let install = Button::new("git-install")
        .size(Size::Sm)
        .variant(Variant::Outline)
        .text(copy.action)
        .on_click(|_: &ClickEvent, _, cx| cx.open_url(GIT_INSTALL_URL));
    let close = IconButton::new("git-dismiss", copy.dismiss)
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
        Notice::new(NoticeTone::Warning, copy.message)
            .title(copy.title)
            .icon(icon(Icon::CircleAlert, IconSize::Lg, ds))
            .action(action)
            .into_any_element(),
    )
}

/// `ComposerCrashFallback`: retry in the composer's floating slot, above the message scroller.
/// `reserve` receives the card's height (`useReserveHeight`).
#[allow(dead_code, reason = "wired by Opus at wave integration")]
pub(crate) fn crash_fallback(
    lang: Lang,
    reserve: Rc<Cell<f32>>,
    retry: impl Fn(&mut Window, &mut App) + 'static,
) -> impl gpui::IntoElement {
    let copy = copy(lang);
    let probe = canvas(
        move |bounds, _, _| reserve.set(bounds.size.height.as_f32()),
        |_, (), _, _| {},
    )
    .absolute()
    .top_0()
    .left_0()
    .size_full();
    let action = Button::new("composer-retry")
        .size(Size::Sm)
        .variant(Variant::Outline)
        .text(copy.retry)
        .on_click(move |_: &ClickEvent, window, cx| retry(window, cx));
    ComposerCard::new("composer-crash")
        .large()
        .child(div().relative().child(probe).child(
            Notice::new(NoticeTone::Error, copy.crashed).action(action),
        ))
}
