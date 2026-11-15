//! TabStrip.showcase.tsx (+ TabStrip.demo.tsx): the browser tab strip in every arrangement. Each
//! demo is the app container in miniature: its state lives here and the strip reports intents.
//! The state matrix is covered by the live harness (hover, focus, active). Pointer drag-reorder
//! is not ported (keyboard reorder, Cmd/Ctrl+Shift+arrows, is).
pub(in crate::pages) mod data;

use butler_ds::ui::Icon;
use butler_ds::ui::blocks::tab_strip::{Group, GroupKind, Tab, TabStrip, apply_move};
use butler_ds::ui::icon_button::IconButton;
use gpui::{
    AnyElement, App, Entity, IntoElement as _, ParentElement as _, SharedString, Styled as _,
    Window, div, px,
};

use data::{crashed_groups, crowded, demo_groups, labels, paired, shoes, trip};

use super::Story;
use crate::copy::Lang;

/// One demo: its groups and how the strip is set up.
#[derive(Clone, Copy)]
struct Spec {
    id: &'static str,
    groups: fn(Lang) -> Vec<Group>,
    active: &'static str,
    hide_chip: bool,
    trailing: bool,
    /// The row's width cap (the overflow story).
    cap: Option<f32>,
}

const BASE: Spec = Spec {
    id: "ts",
    groups: demo_groups,
    active: "m2",
    hide_chip: false,
    trailing: false,
    cap: None,
};

const PAIRED: Spec = Spec {
    id: "ts-paired",
    groups: |l| paired(l, 2),
    ..BASE
};

const MIDDLE: Spec = Spec {
    id: "ts-middle",
    groups: |l| paired(l, 4),
    active: "s2",
    ..BASE
};

const FOLDED: Spec = Spec {
    id: "ts-folded",
    groups: |l| vec![shoes(l, 2), trip(l)],
    active: "s1",
    ..BASE
};

const STATES: Spec = Spec {
    id: "ts-states",
    groups: crashed_groups,
    active: "x1",
    ..BASE
};

const OVERFLOW: Spec = Spec {
    id: "ts-crowded",
    groups: crowded,
    active: "n12",
    cap: Some(600.),
    ..BASE
};

const PANE: Spec = Spec {
    id: "ts-pane",
    groups: |l| vec![shoes(l, 2)],
    active: "s1",
    hide_chip: true,
    trailing: true,
    ..BASE
};

const MINE: Spec = Spec {
    id: "ts-mine",
    groups: |l| demo_groups(l).into_iter().take(1).collect(),
    ..BASE
};

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "My tabs and conversation groups",
            render: |l, w, c| demo(BASE, l, w, c),
        },
        Story {
            name: "My tabs beside one conversation",
            render: |l, w, c| demo(PAIRED, l, w, c),
        },
        Story {
            // Dividers sit between tabs and after the title; they step aside next to the selected tab.
            name: "Dividers: the selected tab in the middle of a group",
            render: |l, w, c| demo(MIDDLE, l, w, c),
        },
        Story {
            // A folded group keeps its title, previews three favicons and counts the rest.
            name: "Folded group: three favicons and +N beside an open group",
            render: |l, w, c| demo(FOLDED, l, w, c),
        },
        Story {
            name: "Group states: working, waiting for approval, crashed tab",
            render: |l, w, c| demo(STATES, l, w, c),
        },
        Story {
            // Tabs in every pill share one width; past the minimum the row scrolls with edge fades.
            name: "Overflow: tabs shrink, then scroll sideways",
            render: |l, w, c| demo(OVERFLOW, l, w, c),
        },
        Story {
            // A conversation's browser pane: only its group, no title or outline, bring-in at the row end.
            name: "Conversation pane: one group without its title, trailing slot",
            render: |l, w, c| demo(PANE, l, w, c),
        },
        Story {
            name: "Only my tabs: plain pill tabs and the row's +",
            render: |l, w, c| demo(MINE, l, w, c),
        },
        Story {
            name: "Locked order, no new-tab button",
            render: locked,
        },
        Story {
            name: "File tabs: a file-type icon per tab",
            render: files,
        },
    ]
}

struct State {
    groups: Vec<Group>,
    active: Option<SharedString>,
    created: usize,
}

impl State {
    fn close(&mut self, tab: &str) {
        let order: Vec<SharedString> = self
            .groups
            .iter()
            .flat_map(|g| g.tabs_ref().iter().map(|t| t.id().clone()))
            .collect();
        let at = order.iter().position(|id| id == tab);
        if let Some(at) = at.filter(|_| self.active.as_deref() == Some(tab)) {
            self.active = order
                .get(at + 1)
                .or_else(|| at.checked_sub(1).and_then(|p| order.get(p)))
                .cloned();
        }
        for group in &mut self.groups {
            group.remove_tab(tab);
        }
        self.groups
            .retain(|g| g.is_mine() || !g.tabs_ref().is_empty());
    }

    /// The row's + opens a tab in "my tabs" (or the only group); a pill's + in its group.
    fn new_tab(&mut self, target: Option<&str>) {
        let id = format!("new-{}", self.created);
        self.created += 1;
        let fallback = self
            .groups
            .iter()
            .find(|g| g.is_mine())
            .or(self.groups.first())
            .map(|g| g.id().clone());
        let target = target.map(SharedString::from).or(fallback);
        if let Some(group) = self
            .groups
            .iter_mut()
            .find(|g| Some(g.id()) == target.as_ref())
        {
            group.push_tab(Tab::new(id.clone(), ""));
            self.active = Some(id.into());
        }
    }
}

fn demo(spec: Spec, lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let state: Entity<State> = window.use_keyed_state(spec.id, cx, |_, _| State {
        groups: (spec.groups)(lang),
        active: Some(spec.active.into()),
        created: 0,
    });
    let mut strip = wired_strip(spec, lang, state, cx);
    if spec.hide_chip {
        strip = strip.hide_chip();
    }
    if spec.trailing {
        let label = lang.pick("Bring in a tab", "내 탭 가져오기");
        strip = strip.child(
            IconButton::new(
                gpui::ElementId::Name(format!("{}-bring", spec.id).into()),
                label,
            )
            .glyph(Icon::TabIn),
        );
    }
    let row = div().w_full();
    match spec.cap {
        Some(cap) => row.max_w(px(cap)),
        None => row,
    }
    .child(strip)
    .into_any_element()
}

/// The strip wired to the demo state: every intent the strip reports updates `state`.
fn wired_strip(spec: Spec, lang: Lang, state: Entity<State>, cx: &App) -> TabStrip {
    let (groups, active) = {
        let current = state.read(cx);
        (current.groups.clone(), current.active.clone())
    };
    let (on_pick, on_close, on_move, on_toggle, on_new, on_new_in) = (
        state.clone(),
        state.clone(),
        state.clone(),
        state.clone(),
        state.clone(),
        state,
    );
    TabStrip::new(
        gpui::ElementId::Name(format!("{}-strip", spec.id).into()),
        groups,
    )
    .active(active)
    .labels(labels(lang))
    .on_activate(move |id, _, cx| {
        on_pick.update(cx, |tabs, cx| {
            tabs.active = Some(id.to_owned().into());
            cx.notify();
        });
    })
    .on_close(move |id, _, cx| {
        on_close.update(cx, |tabs, cx| {
            tabs.close(id);
            cx.notify();
        });
    })
    .on_move(move |mv, _, cx| {
        on_move.update(cx, |tabs, cx| {
            tabs.groups = apply_move(&tabs.groups, mv);
            cx.notify();
        });
    })
    .on_toggle_group(move |id, collapsed, _, cx| {
        on_toggle.update(cx, |tabs, cx| {
            if let Some(group) = tabs.groups.iter_mut().find(|group| group.id() == id) {
                group.set_collapsed(collapsed);
            }
            cx.notify();
        });
    })
    .on_new_tab(move |_, cx| {
        on_new.update(cx, |tabs, cx| {
            tabs.new_tab(None);
            cx.notify();
        });
    })
    .on_new_tab_in_group(move |id, _, cx| {
        on_new_in.update(cx, |tabs, cx| {
            tabs.new_tab(Some(id));
            cx.notify();
        });
    })
}

fn static_strip(
    id: &'static str,
    groups: Vec<Group>,
    active: &str,
    lang: Lang,
    hide: bool,
) -> AnyElement {
    let strip = TabStrip::new(id, groups)
        .active(Some(active.to_owned().into()))
        .labels(labels(lang))
        .on_activate(|_, _, _| {})
        .on_close(|_, _, _| {});
    (if hide { strip.hide_chip() } else { strip }).into_any_element()
}

fn locked(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    static_strip(
        "ts-locked",
        demo_groups(lang).into_iter().take(2).collect(),
        "s2",
        lang,
        false,
    )
}

fn files(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let [doc, code, image] = lang.pick(
        ["release-notes.md", "ime-guard.ts", "shortcut-clash.png"],
        ["릴리스-노트.md", "ime-guard.ts", "단축키-충돌.png"],
    );
    let group = Group::new("files", GroupKind::Mine)
        .tab(Tab::new("f1", doc).icon(Icon::FileText))
        .tab(Tab::new("f2", code).icon(Icon::FileText))
        .tab(Tab::new("f3", image).icon(Icon::ImageIcon));
    static_strip("ts-files", vec![group], "f1", lang, true)
}
