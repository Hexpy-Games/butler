//! SelectionBar.showcase.tsx: 1, 2 and 10 picks, the picking state at 0, floating on wide and
//! narrow page cards (icon actions), one unavailable action, the kept-selection pill and the
//! dimmed bar. The page behind a floating bar is a plain surface.
use butler_ds::tokens::{Color, Length};
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::browser_pane::PanePlacement;
use butler_ds::ui::blocks::page_card::PageCardHolder;
use butler_ds::ui::blocks::selection_bar::{SelectionBar, SelectionBarAction, SelectionPlacement};
use butler_ds::ui::context::Ds;
use butler_ds::ui::layout::{Cross, Space, Stack};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Styled as _, div, px};

use super::Story;
use crate::browser_demo::BandKind;
use crate::browser_pane_demo::{PaneSpec, demo_card};
use crate::copy::Lang;

/// `BROWSER_DEMO_COPY` strings of this showcase.
struct Words {
    attach: &'static str,
    save_image: &'static str,
    scrap: &'static str,
    copy_text: &'static str,
    clear: &'static str,
    pick_empty: &'static str,
    pick_first: &'static str,
    no_text: &'static str,
}

fn words(lang: Lang) -> Words {
    lang.pick(
        Words {
            attach: "Add to chat",
            save_image: "Save image",
            scrap: "Scrap",
            copy_text: "Copy text",
            clear: "Clear",
            pick_empty: "Click an element to pick it",
            pick_first: "Pick an element first",
            no_text: "No text in these picks",
        },
        Words {
            attach: "대화에 첨부",
            save_image: "이미지로 저장",
            scrap: "스크랩",
            copy_text: "텍스트 복사",
            clear: "선택 해제",
            pick_empty: "요소를 눌러 선택하세요",
            pick_first: "먼저 요소를 선택하세요",
            no_text: "고른 요소에 텍스트가 없어요",
        },
    )
}

/// `picked(count)`.
fn picked(lang: Lang, count: usize) -> String {
    lang.pick(format!("{count} selected"), format!("{count}개 선택됨"))
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            // Acceptance: 1, 2 and 10 picks, one line each.
            name: "1, 2 and 10 picks",
            render: |l, _, _| {
                column(vec![
                    bar("sb-1", 1, Spec::default(), l),
                    bar("sb-2", 2, Spec::default(), l),
                    bar("sb-10", 10, Spec::default(), l),
                ])
            },
        },
        Story {
            // Pick mode just started: the bar is there, with a hint and unavailable actions.
            name: "Picking, nothing picked yet (0)",
            render: |l, _, _| column(vec![bar("sb-0", 0, Spec::default(), l)]),
        },
        Story {
            name: "Picking on a page (0)",
            render: |l, _, c| on_page("sb-page-0", 720., 0, l, c),
        },
        Story {
            name: "Picking on a narrow page (0)",
            render: |l, _, c| on_page("sb-narrow-0", 360., 0, l, c),
        },
        Story {
            // One action can be unavailable for its own reason while the others work.
            name: "One unavailable action",
            render: |l, _, _| {
                let spec = Spec {
                    no_text: true,
                    ..Spec::default()
                };
                column(vec![bar("sb-unavailable", 2, spec, l)])
            },
        },
        Story {
            name: "Kept selection (pick mode off): the pill",
            render: |l, _, _| {
                let spec = Spec {
                    compact: true,
                    ..Spec::default()
                };
                column(vec![bar("sb-pill", 2, spec, l)])
            },
        },
        Story {
            name: "Dimmed while the picks are dragged",
            render: |l, _, _| {
                let spec = Spec {
                    dimmed: true,
                    ..Spec::default()
                };
                column(vec![bar("sb-dimmed", 2, spec, l)])
            },
        },
        Story {
            name: "Floating on a wide page",
            render: |l, _, c| on_page("sb-wide", 720., 2, l, c),
        },
        Story {
            // Narrow page cards keep one line: icon-only actions with tooltips.
            name: "Floating on a narrow page (icon actions)",
            render: |l, _, c| on_page("sb-icons", 420., 10, l, c),
        },
    ]
}

#[derive(Clone, Copy, Default)]
struct Spec {
    compact: bool,
    dimmed: bool,
    /// The copy action is unavailable for its own reason.
    no_text: bool,
}

fn column(bars: Vec<AnyElement>) -> AnyElement {
    Stack::new()
        .gap(Space::Sm)
        .cross(Cross::Start)
        .children(bars)
        .into_any_element()
}

/// `actions(context)`.
fn actions(w: &Words, no_text: bool) -> Vec<SelectionBarAction> {
    let copy = SelectionBarAction::new("copy", w.copy_text, Icon::Copy);
    vec![
        SelectionBarAction::new("attach", w.attach, Icon::MessageSquarePlus).on_select(|_, _| {}),
        SelectionBarAction::new("image", w.save_image, Icon::ImageIcon).on_select(|_, _| {}),
        SelectionBarAction::new("scrap", w.scrap, Icon::Scrap).on_select(|_, _| {}),
        if no_text {
            copy.unavailable(w.no_text)
        } else {
            copy.on_select(|_, _| {})
        },
    ]
}

fn make(
    id: &'static str,
    count: usize,
    spec: Spec,
    placement: SelectionPlacement,
    lang: Lang,
) -> SelectionBar {
    let w = words(lang);
    let mut bar = SelectionBar::new(id, count, picked(lang, count), w.clear)
        .hint(w.pick_empty)
        .empty_reason(w.pick_first)
        .dimmed(spec.dimmed)
        .placement(placement)
        .on_clear(|_, _| {});
    for action in actions(&w, spec.no_text) {
        bar = bar.action(action);
    }
    if spec.compact {
        bar = bar.compact();
    }
    bar
}

/// `Bar`: in flow.
fn bar(id: &'static str, count: usize, spec: Spec, lang: Lang) -> AnyElement {
    make(id, count, spec, SelectionPlacement::Inline, lang).into_any_element()
}

/// `OnPage`: floating over a page card of a given width (the bar answers to the card's width),
/// in a pane-coloured stage like PageCardDemo's.
fn on_page(id: &'static str, width: f32, count: usize, lang: Lang, cx: &App) -> AnyElement {
    let ds = Ds::get(cx);
    let pane = PaneSpec {
        placement: PanePlacement::Conversation,
        holder: PageCardHolder::None,
        band: Some(BandKind::Pick),
        agent: false,
        loading: None,
    };
    let card = demo_card(id, pane, lang, false, cx).overlay(make(
        id,
        count,
        Spec::default(),
        SelectionPlacement::Floating,
        lang,
    ));
    div()
        .w_full()
        .max_w(px(width))
        .child(
            div()
                .flex()
                .h(px(300.))
                .p(ds.len(Length::BrowserCardInset))
                .rounded(ds.len(Length::RadiusPanel))
                .bg(ds.color(Color::BrowserPaneBg))
                .child(card),
        )
        .into_any_element()
}
