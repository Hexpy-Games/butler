//! NavDropTarget.showcase.tsx (with NavDropTarget.demo.tsx and NavDropTarget.outside.tsx): the
//! drag feedback of a sidebar tree. The interactive story is a real gpui drag (`on_drag`,
//! `on_drag_move`, `on_drop`; React uses native HTML5 drag): press a row and drag it over the
//! others. The rest show each state at rest.
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::nav_drop::auto_scroll::Edge;
use butler_ds::ui::blocks::nav_drop::{
    NavDropPosition, NavDropScope, NavDropTarget, NavRootDropZone, Payload,
};
use butler_ds::ui::blocks::nav_row::NavRow;
use butler_ds::ui::button::{Button, Variant};
use butler_ds::ui::layout::{Space, Stack};
use gpui::{
    AnyElement, App, InteractiveElement as _, IntoElement as _, ParentElement as _, ScrollHandle,
    SharedString, StatefulInteractiveElement as _, Styled as _, Window, div, px,
};

use super::{Story, probe};
use crate::copy::Lang;

mod copy;
mod interactive;

use self::copy::copy;
use self::interactive::interactive;

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Drag and drop (interactive)",
            render: interactive,
        },
        Story {
            name: "Drag sequence (slot, ring)",
            render: sequence,
        },
        Story {
            name: "Insert before",
            render: |lang, _, cx| rows(lang, Some(NavDropPosition::Before), 1, cx),
        },
        Story {
            name: "Insert after",
            render: |lang, _, cx| rows(lang, Some(NavDropPosition::After), 1, cx),
        },
        Story {
            name: "Drop inside a folder",
            render: |lang, _, cx| rows(lang, Some(NavDropPosition::Inside), 0, cx),
        },
        Story {
            name: "Group two conversations",
            render: |lang, _, cx| rows(lang, Some(NavDropPosition::Group), 1, cx),
        },
        Story {
            name: "Outside payload: sequence (rows never move)",
            render: outside_sequence,
        },
        Story {
            name: "Outside payload: attach to a conversation",
            render: |lang, _, _| {
                outside_rows(lang, Outside::Conversation, "ndt-outside-conversation")
            },
        },
        Story {
            name: "Outside payload: save to the library",
            render: |lang, _, _| outside_rows(lang, Outside::Library, "ndt-outside-library"),
        },
        Story {
            name: "Outside payload: invalid target",
            render: |lang, _, _| outside_rows(lang, Outside::Invalid, "ndt-outside-invalid"),
        },
        Story {
            name: "Outside payload: auto-scroll at the edge",
            render: auto_scroll,
        },
        Story {
            name: "Root drop zone",
            render: |lang, _, _| {
                NavRootDropZone::new(copy(lang).root)
                    .active(true)
                    .into_any_element()
            },
        },
    ]
}

/// Header box of a 30px comfortable row, as the product measures it.
pub(super) const HEADER: (f32, f32) = (0., 30.);

fn nav_row(id: SharedString, label: &'static str, glyph: Icon) -> NavRow {
    NavRow::new(id, label).glyph(glyph).on_click(|_, _, _| {})
}

fn rows(lang: Lang, drop: Option<NavDropPosition>, target: usize, cx: &mut App) -> AnyElement {
    sequence_rows(lang, (drop, target), Some(3), cx)
}

/// The four rows of the showcase: one target, one dragged row.
fn sequence_rows(
    lang: Lang,
    (drop, target): (Option<NavDropPosition>, usize),
    dragging: Option<usize>,
    _: &mut App,
) -> AnyElement {
    let c = copy(lang);
    let mut scope = NavDropScope::new("ndt-rows").active(true);
    for (index, label) in c.rows.iter().take(4).enumerate() {
        let glyph = if index == 0 {
            Icon::Briefcase
        } else {
            Icon::MessageSquare
        };
        let key = SharedString::from(format!("ndt-row-{index}"));
        scope = scope.row(
            NavDropTarget::new(key.clone(), nav_row(key, label, glyph))
                .drop(if index == target { drop } else { None })
                .dragging(dragging == Some(index))
                .indicator(HEADER.0, HEADER.1)
                .hint(c.group),
        );
    }
    scope.into_any_element()
}

/// A counter held in the page's state, stepped by a button.
fn stepper(
    id: &'static str,
    window: &mut Window,
    cx: &mut App,
) -> (
    usize,
    impl Fn(&gpui::ClickEvent, &mut Window, &mut App) + 'static,
) {
    let state = window.use_keyed_state(id, cx, |_, _| 0_usize);
    let step = *state.read(cx);
    (
        step,
        move |_: &gpui::ClickEvent, _: &mut Window, cx: &mut App| {
            state.update(cx, |step, cx| {
                *step += 1;
                cx.notify();
            });
        },
    )
}

fn sequence(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    const STEPS: [(Option<NavDropPosition>, usize); 5] = [
        (Some(NavDropPosition::Before), 1),
        (Some(NavDropPosition::Group), 1),
        (Some(NavDropPosition::After), 1),
        (Some(NavDropPosition::Inside), 0),
        (None, 1),
    ];
    let (step, advance) = stepper("ndt-sequence", window, cx);
    let (drop, target) = STEPS[step % STEPS.len()];
    let name = match drop {
        Some(NavDropPosition::Before) => "before",
        Some(NavDropPosition::After) => "after",
        Some(NavDropPosition::Inside) => "inside",
        Some(NavDropPosition::Group) => "group",
        _ => "rest",
    };
    Stack::new()
        .gap(Space::Sm)
        .child(
            Button::new("ndt-step")
                .variant(Variant::Outline)
                .text(format!("{}: {name}", copy(lang).step))
                .on_click(advance),
        )
        .child(sequence_rows(lang, (drop, target), Some(3), cx))
        .child(probe(format!("ndt-sequence-{name}")))
        .into_any_element()
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Outside {
    Rest,
    Conversation,
    Library,
    Invalid,
}

fn outside_rows(lang: Lang, state: Outside, id: &'static str) -> AnyElement {
    let c = copy(lang);
    let active = state != Outside::Rest;
    let mut targets = Vec::new();
    let mut add = |key: String,
                   label: &'static str,
                   glyph: Icon,
                   drop: bool,
                   hint: &'static str,
                   invalid: bool| {
        let id = SharedString::from(key);
        let mut target = NavDropTarget::new(id.clone(), nav_row(id, label, glyph))
            .indicator(HEADER.0, HEADER.1)
            .hint(hint)
            .invalid(invalid);
        if drop {
            target = target.drop(Some(NavDropPosition::Outside));
        }
        targets.push(target);
    };
    add(
        "schedules".into(),
        c.schedules,
        Icon::Clock3,
        state == Outside::Invalid,
        c.invalid,
        true,
    );
    add(
        "library".into(),
        c.library,
        Icon::Library,
        state == Outside::Library,
        c.save,
        false,
    );
    for (index, label) in c.chats.iter().enumerate() {
        add(
            format!("c{index}"),
            label,
            Icon::MessageSquare,
            state == Outside::Conversation && index == 1,
            c.attach,
            false,
        );
    }
    let mut scope = NavDropScope::new(id)
        .active(active)
        .payload(Payload::Outside);
    for target in targets {
        scope = scope.row(target);
    }
    div()
        .w(px(304.))
        .max_w_full()
        .child(scope)
        .into_any_element()
}

fn outside_sequence(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    const STEPS: [Outside; 4] = [
        Outside::Rest,
        Outside::Conversation,
        Outside::Library,
        Outside::Invalid,
    ];
    let (step, advance) = stepper("ndt-outside-sequence", window, cx);
    let state = STEPS[step % STEPS.len()];
    let name = match state {
        Outside::Rest => "rest",
        Outside::Conversation => "conversation",
        Outside::Library => "library",
        Outside::Invalid => "invalid",
    };
    Stack::new()
        .gap(Space::Sm)
        .child(
            Button::new("ndt-outside-step")
                .variant(Variant::Outline)
                .text(format!("{}: {name}", copy(lang).step))
                .on_click(advance),
        )
        .child(outside_rows(lang, state, "ndt-outside-sequence-rows"))
        .into_any_element()
}

/// A dragged payload held near the bottom of a scrolled list: the band shows it is scrolling.
fn auto_scroll(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let handle = window
        .use_keyed_state("ndt-scroll", cx, |_, _| ScrollHandle::new())
        .read(cx)
        .clone();
    let mut scope = NavDropScope::new("ndt-auto")
        .active(true)
        .payload(Payload::Outside)
        .auto_scroll(Some(Edge::End))
        .scroll(handle.clone());
    for (index, label) in c.chats.iter().chain(c.more.iter()).enumerate() {
        let id = SharedString::from(format!("ndt-auto-{index}"));
        scope = scope.row(
            NavDropTarget::new(id.clone(), nav_row(id, label, Icon::MessageSquare))
                .indicator(HEADER.0, HEADER.1),
        );
    }
    div()
        .id("ndt-auto-list")
        .w(px(304.))
        .max_w_full()
        .h(px(200.))
        .overflow_y_scroll()
        .track_scroll(&handle)
        .child(scope)
        .into_any_element()
}
