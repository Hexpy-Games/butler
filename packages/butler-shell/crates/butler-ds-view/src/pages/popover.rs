//! Popover.showcase.tsx. ComposerControl, FilteredSelectPopover and SuggestionList are
//! stand-ins (`standins_overlay.rs`); the "Bottom sheet on phones" story shows its trigger and
//! stays anchored until BottomSheet (batch B5) provides the sheet presentation.
use std::rc::Rc;

use butler_ds::ui::Icon;
use butler_ds::ui::context::Ds;
use butler_ds::ui::layout::{Space, Stack, WithItem as _};
use butler_ds::ui::overlay::Presentation;
use butler_ds::ui::overlay::place::{Align, Side};
use butler_ds::ui::popover::{
    Density, MenuSize, Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle,
    Width,
};
use butler_ds::ui::select_button::SelectButton;
use butler_ds::ui::text::Input;
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window};

use super::Story;
use crate::copy::Lang;
use crate::standins_overlay::{Row, composer_control, filtered_select, suggestion_row};

struct Copy {
    access: &'static str,
    access_title: &'static str,
    access_body: &'static str,
    model: &'static str,
    search: &'static str,
    models: [(&'static str, &'static str); 3],
    anchor: &'static str,
    open: &'static str,
    context: &'static str,
    narrow: &'static str,
    field: &'static str,
}

fn copy(lang: Lang) -> Copy {
    let models = [
        ("model-1", "Model 5.1"),
        ("model-2", "Model Opus"),
        ("model-3", "Model Coder 14B"),
    ];
    lang.pick(
        Copy {
            access: "Ask",
            access_title: "Access",
            access_body: "Butler asks before editing files or running commands.",
            model: "Model",
            search: "Search models",
            models,
            anchor: "The popover anchors to this line, not to the button.",
            open: "Open",
            context: "Context",
            narrow: "Narrow readout: min(280px, 100vw - 32px).",
            field: "Search or enter URL",
        },
        Copy {
            access: "질문",
            access_title: "권한",
            access_body: "버틀러가 파일을 고치거나 명령을 실행하기 전에 묻습니다.",
            model: "모델",
            search: "모델 검색",
            models,
            anchor: "팝오버는 버튼이 아니라 이 줄에 붙습니다.",
            open: "열기",
            context: "컨텍스트",
            narrow: "좁은 요약: min(280px, 100vw - 32px).",
            field: "검색 또는 URL 입력",
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Composer access menu",
            render: access,
        },
        Story {
            name: "Searchable select",
            render: searchable,
        },
        Story {
            name: "Custom anchor",
            render: custom_anchor,
        },
        Story {
            name: "Narrow width",
            render: narrow,
        },
        Story {
            name: "Anchor width list",
            render: anchor_width,
        },
        Story {
            name: "Bottom sheet on phones (presentation=\"auto\")",
            render: sheet,
        },
    ]
}

/// AccessModeMenu: a composer pill opens a compact popover above it.
fn access(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let popover = Popover::new("popover-access", window, cx);
    let trigger = popover.trigger(|toggle| {
        composer_control(
            "popover-access-trigger",
            Icon::ShieldCheck,
            c.access,
            toggle.on_click(),
            cx,
        )
    });
    let content = popover.content(
        PopoverContent::new()
            .align(Align::Start)
            .menu_size(MenuSize::Compact)
            .side(Side::Top)
            .side_offset(10.)
            .child(
                PopoverHeader::new()
                    .child(PopoverTitle::new(c.access_title))
                    .child(PopoverDescription::new(c.access_body)),
            ),
        window,
        cx,
    );
    Stack::new()
        .child(trigger)
        .child(content)
        .into_any_element()
}

/// SettingsSearchableSelect: SelectButton + FilteredSelectPopover.
fn searchable(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let open = window.use_keyed_state("popover-select-open", cx, |_, _| false);
    let value = window.use_keyed_state("popover-select-value", cx, |_, _| "model-1");
    let current = *value.read(cx);
    let set_open = open.clone();
    let popover = Popover::new("popover-select", window, cx)
        .open(*open.read(cx))
        .on_open_change(move |next, _, cx| {
            set_open.update(cx, |open, cx| {
                *open = next;
                cx.notify();
            });
        });
    let label = c
        .models
        .iter()
        .find(|(id, _)| *id == current)
        .map_or("", |(_, label)| *label);
    let trigger = popover.trigger_fill(|toggle| {
        SelectButton::new("popover-select-trigger")
            .text(label)
            .on_click(toggle.on_click())
            .into_any_element()
    });
    let rows: Vec<Row> = c
        .models
        .iter()
        .map(|(id, label)| {
            let (value, open) = (value.clone(), open.clone());
            let id: &'static str = id;
            Row {
                id,
                label,
                selected: id == current,
                on_select: Rc::new(move |_, cx| {
                    value.update(cx, |value, cx| {
                        *value = id;
                        cx.notify();
                    });
                    open.update(cx, |open, cx| {
                        *open = false;
                        cx.notify();
                    });
                }),
            }
        })
        .collect();
    let list = filtered_select(c.model, c.search, c.model, c.model, &rows, window, cx);
    let content = popover.content(
        PopoverContent::new()
            .align(Align::End)
            .menu_size(MenuSize::Fit)
            .side_offset(6.)
            .child(list),
        window,
        cx,
    );
    Stack::new()
        .child(trigger)
        .child(content)
        .into_any_element()
}

/// The popover anchors to a caption, not to the button that toggles it.
fn custom_anchor(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let popover = Popover::new("popover-anchor", window, cx);
    let anchor = popover.anchor(Typo::caption(c.anchor).tone(Tone::Secondary));
    let trigger = popover.trigger_fill(|toggle| {
        SelectButton::new("popover-anchor-trigger")
            .text(c.open)
            .on_click(toggle.on_click())
            .into_any_element()
    });
    let content = popover.content(
        PopoverContent::new()
            .align(Align::Start)
            .child(Typo::body(c.access_body)),
        window,
        cx,
    );
    Stack::new()
        .child(Stack::new().gap(Space::Sm).child(anchor).child(trigger))
        .child(content)
        .into_any_element()
}

fn narrow(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let popover = Popover::new("popover-narrow", window, cx);
    let trigger = popover.trigger_fill(|toggle| {
        SelectButton::new("popover-narrow-trigger")
            .text(c.context)
            .on_click(toggle.on_click())
            .into_any_element()
    });
    let content = popover.content(
        PopoverContent::new()
            .side(Side::Top)
            .width(Width::Narrow)
            .child(Typo::caption(c.narrow).tone(Tone::Secondary)),
        window,
        cx,
    );
    Stack::new()
        .child(trigger)
        .child(content)
        .into_any_element()
}

/// AddressSuggestions: the list is exactly as wide as the field it completes.
fn anchor_width(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let popover = Popover::new("popover-width", window, cx);
    let anchor = popover.anchor(
        Stack::new()
            .grow()
            .child(Input::new("popover-width-field").placeholder(c.field)),
    );
    let trigger = popover.trigger_fill(|toggle| {
        SelectButton::new("popover-width-trigger")
            .text(c.open)
            .on_click(toggle.on_click())
            .into_any_element()
    });
    let ds = Ds::get(cx);
    let rows = [
        ("docs.example.com/", true),
        ("mail.example.net/inbox", false),
    ]
    .map(|(address, active)| suggestion_row(address, active, ds));
    let content = popover.content(
        PopoverContent::new()
            .align(Align::Start)
            .width(Width::Anchor)
            .density(Density::List)
            .child(Stack::new().gap(Space::None).children(rows)),
        window,
        cx,
    );
    Stack::new()
        .gap(Space::None)
        .child(anchor)
        .child(trigger)
        .child(content)
        .into_any_element()
}

/// `presentation="auto"`: a BottomSheet below 768px, the anchored popover above. The sheet is
/// batch B5's; here the popover stays anchored.
fn sheet(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let popover = Popover::new("popover-sheet", window, cx);
    let trigger = popover.trigger_fill(|toggle| {
        SelectButton::new("popover-sheet-trigger")
            .text(c.open)
            .on_click(toggle.on_click())
            .into_any_element()
    });
    let content = popover.content(
        PopoverContent::new()
            .presentation(Presentation::Auto)
            .child(
                PopoverHeader::new()
                    .child(PopoverTitle::new(c.access_title))
                    .child(PopoverDescription::new(c.access_body)),
            ),
        window,
        cx,
    );
    Stack::new()
        .child(trigger)
        .child(content)
        .into_any_element()
}
