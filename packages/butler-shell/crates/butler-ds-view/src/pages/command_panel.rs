//! CommandPanel.showcase.tsx: the Cmd+K palette with three results, filtered by the typed text.
//! The trigger button opens it; Cmd+K (Ctrl+K off macOS) opens and closes it while focus is on
//! the story, and Escape or the close button closes it.
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::command_panel::{
    CommandPaletteItem, CommandPalettePanel, is_toggle_key,
};
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::layout::{Space, Stack};
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{
    AnyElement, App, Entity, InteractiveElement as _, IntoElement as _, ParentElement as _,
    SharedString, Window, div,
};

use super::Story;
use crate::copy::Lang;

struct Copy {
    label: &'static str,
    placeholder: &'static str,
    close: &'static str,
    open: &'static str,
    hint: &'static str,
    results: [&'static str; 3],
    chosen: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            label: "Command palette",
            placeholder: "Search conversations, projects and settings",
            close: "Close",
            open: "Open palette",
            hint: "Cmd+K (Ctrl+K) opens and closes it; Escape closes. Typing Korean (IME) never triggers it.",
            results: ["Desktop client polish", "Weekly review", "Appearance settings"],
            chosen: "Chose",
        },
        Copy {
            label: "명령 팔레트",
            placeholder: "대화, 프로젝트, 설정 검색",
            close: "닫기",
            open: "팔레트 열기",
            hint: "Cmd+K(Ctrl+K)로 열고 닫고, Esc로 닫습니다. 한글 입력(IME) 중에는 열리지 않습니다.",
            results: ["데스크톱 앱 다듬기", "주간 회고", "화면 설정"],
            chosen: "선택:",
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![Story {
        name: "Palette (Cmd+K open and close)",
        render: palette,
    }]
}

/// Stores `value` into `state` and repaints.
fn put<T: 'static>(state: &Entity<T>, value: T, cx: &mut App) {
    state.update(cx, |state, cx| {
        *state = value;
        cx.notify();
    });
}

/// Cmd+K toggles the palette; it scales 0.98 to 1 with a backdrop fade and leaves faster.
fn palette(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let open: Entity<bool> = window.use_keyed_state("command-panel-open", cx, |_, _| false);
    let query: Entity<SharedString> =
        window.use_keyed_state("command-panel-query", cx, |_, _| SharedString::default());
    let chosen: Entity<SharedString> =
        window.use_keyed_state("command-panel-chosen", cx, |_, _| "—".into());
    let (is_open, typed, picked) = (
        *open.read(cx),
        query.read(cx).clone(),
        chosen.read(cx).clone(),
    );
    let ds = Ds::get(cx);
    let needle = typed.trim().to_lowercase();
    let glyphs = [Icon::Briefcase, Icon::Notebook, Icon::Settings];
    let items = c
        .results
        .iter()
        .zip(glyphs)
        .enumerate()
        .filter(|(_, (title, _))| title.to_lowercase().contains(&needle))
        .map(|(index, (title, glyph))| {
            let (open, chosen, title) = (open.clone(), chosen.clone(), *title);
            CommandPaletteItem::new(index.to_string(), title, move |_, cx| {
                put(&chosen, SharedString::from(title), cx);
                put(&open, false, cx);
            })
            .icon(icon(glyph, IconSize::Md, ds))
        })
        .collect();
    let (toggle, platform) = (open.clone(), ds.platform());
    let trigger = {
        let open = open.clone();
        Button::new("command-panel-trigger")
            .variant(Variant::Outline)
            .size(Size::Default)
            .text(c.open)
            .on_click(move |_, _, cx| put(&open, true, cx))
    };
    let panel = CommandPalettePanel::new("command-panel", c.label, c.placeholder, c.close)
        .open(is_open)
        .query(typed, {
            let query = query.clone();
            move |text, _, cx| put(&query, SharedString::from(text.to_owned()), cx)
        })
        .items(items)
        .on_close({
            let open = open.clone();
            move |_, cx| put(&open, false, cx)
        });
    div()
        .capture_key_down(move |event, _, cx| {
            if is_toggle_key(event, platform) {
                let next = !*toggle.read(cx);
                put(&toggle, next, cx);
                cx.stop_propagation();
            }
        })
        .child(
            Stack::new()
                .gap(Space::Sm)
                .child(Typo::caption(c.hint).tone(Tone::Secondary))
                .child(trigger)
                .child(Typo::caption(format!("{} {}", c.chosen, picked)))
                .child(panel),
        )
        .into_any_element()
}
