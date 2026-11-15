//! PageCard.showcase.tsx (+ PageCard.demo.tsx): every holder, the reserved band row (the page
//! never moves: the readout is the bounds the engine would get), Butler's fixed 1280x800 page,
//! the load line and the empty and crashed states. The page is a plain surface here.
use butler_ds::tokens::{Color, Length};
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::empty_line::EmptyLine;
use butler_ds::ui::blocks::page_card::{PageCardBounds, PageCardHolder};
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::layout::{Columns, Grid, Space, Stack};
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{
    AnyElement, App, Entity, IntoElement as _, ParentElement as _, Styled as _, Window, div, px,
};

use super::Story;
use crate::browser_demo::{BandKind, sub};
use crate::browser_pane_demo::{PaneSpec, demo_card, readout};
use crate::copy::Lang;
use butler_ds::ui::blocks::browser_pane::PanePlacement;

#[derive(Clone, Copy, PartialEq)]
enum State {
    Page,
    Empty,
    Crashed,
}

/// `PageCardDemoProps`.
#[derive(Clone, Copy)]
struct Demo {
    id: &'static str,
    holder: PageCardHolder,
    band: Option<BandKind>,
    loading: Option<f32>,
    agent: bool,
    state: State,
    height: f32,
    readout: bool,
    reserve: bool,
}

const BASE: Demo = Demo {
    id: "pc",
    holder: PageCardHolder::None,
    band: None,
    loading: None,
    agent: false,
    state: State::Page,
    height: 320.,
    readout: false,
    reserve: false,
};

pub(super) fn stories() -> Vec<Story> {
    let mut all = first_stories();
    all.extend(more_stories());
    all
}

fn first_stories() -> Vec<Story> {
    vec![
        Story {
            name: "Butler holds the tab (riso edge, fixed 1280×800 page)",
            render: |l, w, c| {
                demo(
                    Demo {
                        id: "pc-butler",
                        holder: PageCardHolder::Butler,
                        band: Some(BandKind::Agent),
                        loading: Some(64.),
                        agent: true,
                        height: 420.,
                        readout: true,
                        reserve: true,
                        ..BASE
                    },
                    l,
                    w,
                    c,
                )
            },
        },
        Story {
            // The band row is reserved: no band, agent and pick leave the page's bounds unchanged.
            name: "Reserved band row: the page never moves",
            render: reserved,
        },
        Story {
            // Your tab: the row stays empty and quiet until a band arrives; the bounds do not change.
            name: "Your tab: an empty reserved row",
            render: your_tab,
        },
        Story {
            name: "You hold the tab",
            render: |l, w, c| {
                demo(
                    Demo {
                        id: "pc-user",
                        holder: PageCardHolder::User,
                        band: Some(BandKind::User),
                        agent: true,
                        height: 420.,
                        reserve: true,
                        ..BASE
                    },
                    l,
                    w,
                    c,
                )
            },
        },
    ]
}

fn more_stories() -> Vec<Story> {
    vec![
        Story {
            name: "Waiting for approval (static amber)",
            render: |l, w, c| {
                demo(
                    Demo {
                        id: "pc-waiting",
                        holder: PageCardHolder::Waiting,
                        band: Some(BandKind::Waiting),
                        agent: true,
                        height: 420.,
                        reserve: true,
                        ..BASE
                    },
                    l,
                    w,
                    c,
                )
            },
        },
        Story {
            // The page's bounds are the content area: inside the 1px border, under the band.
            name: "Your page at the card's size, loading",
            render: |l, w, c| {
                demo(
                    Demo {
                        id: "pc-loading",
                        loading: Some(64.),
                        readout: true,
                        ..BASE
                    },
                    l,
                    w,
                    c,
                )
            },
        },
        Story {
            name: "Holders side by side",
            render: holders,
        },
        Story {
            name: "No tab (empty)",
            render: |l, w, c| {
                demo(
                    Demo {
                        id: "pc-empty",
                        state: State::Empty,
                        height: 200.,
                        ..BASE
                    },
                    l,
                    w,
                    c,
                )
            },
        },
        Story {
            name: "Crashed tab",
            render: |l, w, c| {
                demo(
                    Demo {
                        id: "pc-crashed",
                        state: State::Crashed,
                        height: 200.,
                        ..BASE
                    },
                    l,
                    w,
                    c,
                )
            },
        },
    ]
}

fn grid(id: &'static str, columns: u8, cells: Vec<AnyElement>) -> AnyElement {
    Grid::new(id)
        .columns(Columns::fixed(columns))
        .gap(Space::Md)
        .children(cells)
        .into_any_element()
}

fn reserved(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let base = Demo {
        height: 240.,
        readout: true,
        reserve: true,
        agent: true,
        ..BASE
    };
    let cells = vec![
        demo(
            Demo {
                id: "pc-res-a",
                ..base
            },
            lang,
            window,
            cx,
        ),
        demo(
            Demo {
                id: "pc-res-b",
                holder: PageCardHolder::Butler,
                band: Some(BandKind::Agent),
                ..base
            },
            lang,
            window,
            cx,
        ),
        demo(
            Demo {
                id: "pc-res-c",
                band: Some(BandKind::Pick),
                ..base
            },
            lang,
            window,
            cx,
        ),
    ];
    grid("pc-reserved", 3, cells)
}

fn your_tab(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let base = Demo {
        height: 240.,
        readout: true,
        reserve: true,
        ..BASE
    };
    let cells = vec![
        demo(
            Demo {
                id: "pc-your-a",
                ..base
            },
            lang,
            window,
            cx,
        ),
        demo(
            Demo {
                id: "pc-your-b",
                band: Some(BandKind::Popup),
                ..base
            },
            lang,
            window,
            cx,
        ),
    ];
    grid("pc-your", 2, cells)
}

fn holders(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let base = Demo {
        height: 240.,
        ..BASE
    };
    let cells = [
        ("pc-h-none", PageCardHolder::None),
        ("pc-h-butler", PageCardHolder::Butler),
        ("pc-h-user", PageCardHolder::User),
        ("pc-h-waiting", PageCardHolder::Waiting),
    ]
    .into_iter()
    .map(|(id, holder)| demo(Demo { id, holder, ..base }, lang, window, cx))
    .collect();
    grid("pc-holders", 2, cells)
}

/// `PageCardDemo`: a page card with a stand-in page, inset in a pane-coloured stage like
/// BrowserPane's.
fn demo(spec: Demo, lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let (empty, new_tab, crashed, reload, waiting) = lang.pick(
        (
            "Open a new tab",
            "New tab",
            "Tab stopped",
            "Reload",
            "waiting for the first frame",
        ),
        (
            "새 탭을 열어보세요",
            "새 탭",
            "탭이 중단됨",
            "새로고침",
            "첫 프레임 대기 중",
        ),
    );
    let bounds: Entity<Option<PageCardBounds>> =
        window.use_keyed_state(sub(spec.id, "bounds"), cx, |_, _| None);
    let sink = bounds.clone();
    let pane = PaneSpec {
        placement: PanePlacement::Conversation,
        holder: spec.holder,
        band: spec.band,
        agent: spec.agent,
        loading: spec.loading,
    };
    let mut card = demo_card(spec.id, pane, lang, spec.reserve, cx)
        .on_bounds_change(move |next, _, cx| sink.update(cx, |last, _| *last = Some(next)));
    if spec.state != State::Page {
        let ds = Ds::get(cx);
        let line = match spec.state {
            State::Crashed => EmptyLine::new(crashed)
                .icon(icon(Icon::AlertCircle, IconSize::Md, ds))
                .action(
                    Button::new("pc-reload")
                        .size(Size::Sm)
                        .variant(Variant::Outline)
                        .icon_start(icon(Icon::RefreshCcw, IconSize::Md, ds))
                        .text(reload),
                ),
            _ => EmptyLine::new(empty).action(
                Button::new("pc-new-tab")
                    .size(Size::Sm)
                    .variant(Variant::Outline)
                    .icon_start(icon(Icon::Plus, IconSize::Md, ds))
                    .text(new_tab),
            ),
        };
        card = card.hidden(true).child(
            div()
                .flex()
                .flex_auto()
                .items_center()
                .justify_center()
                .child(line),
        );
    }
    let ds = Ds::get(cx);
    let stage = div()
        .flex()
        .h(px(spec.height))
        .p(ds.len(Length::BrowserCardInset))
        .rounded(ds.len(Length::RadiusPanel))
        .bg(ds.color(Color::BrowserPaneBg))
        .child(card);
    let line = spec.readout.then(|| {
        Typo::caption(readout(*bounds.read(cx), waiting))
            .tone(Tone::Secondary)
            .tabular()
    });
    Stack::new()
        .gap(Space::Xs)
        .child(stage)
        .children(line)
        .into_any_element()
}
