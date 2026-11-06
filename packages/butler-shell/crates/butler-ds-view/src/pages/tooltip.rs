//! Tooltip.showcase.tsx. The side and align selectors (SegmentedControl) and the "disabled
//! reason beside a settings control" story (Switch, SettingsField) wait for the next run;
//! "Why a control is unavailable" needs the ComposerControl block.
use butler_ds::tokens::Length;
use butler_ds::ui::Icon;
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::icon_button::IconButton;
use butler_ds::ui::layout::{Border, Box as DsBox, Justify, Radius, Space, Stack};
use butler_ds::ui::tooltip::{Align, Side, Tooltip};
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Styled as _, Window, div};

use super::Story;
use crate::copy::Lang;

struct Copy {
    hint: &'static str,
    panel: &'static str,
    shortcut: &'static str,
    long: &'static str,
    trigger: &'static str,
    placed: &'static str,
    top: &'static str,
    start: &'static str,
    placement_hint: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            hint: "Hover for 650ms or focus with the keyboard. Tooltips name controls; they never hold actions.",
            panel: "Show right panel",
            shortcut: "Copy link",
            long: "Opens the project dashboard in the right panel and keeps the conversation in place",
            trigger: "Trigger",
            placed: "Opens here",
            top: "Top",
            start: "Start",
            placement_hint: "Shown open here. Without room it flips to the other side and shifts to stay on screen.",
        },
        Copy {
            hint: "650ms 동안 올려 두거나 키보드로 포커스하세요. 툴팁은 컨트롤 이름만 보여 주며 동작을 담지 않습니다.",
            panel: "오른쪽 패널 보기",
            shortcut: "링크 복사",
            long: "대화를 그대로 둔 채 오른쪽 패널에서 프로젝트 대시보드를 엽니다",
            trigger: "기준",
            placed: "여기에 열림",
            top: "위",
            start: "시작",
            placement_hint: "여기서는 열린 채로 보입니다. 자리가 없으면 반대쪽으로 넘어가고 화면 안으로 밀려 들어옵니다.",
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Icon button label",
            render: icon_label,
        },
        Story {
            name: "Placement: side and align",
            render: placement,
        },
        Story {
            name: "Long label wraps inside the viewport",
            render: long_label,
        },
    ]
}

fn icon_label(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    Stack::new()
        .gap(Space::Sm)
        .child(IconButton::new("tooltip-panel", c.panel).icon(icon(
            Icon::PanelRight,
            IconSize::Md,
            Ds::get(cx),
        )))
        .child(Typo::caption(c.hint).tone(Tone::Secondary))
        .into_any_element()
}

/// The open tooltip around one trigger, at the selectors' initial side and align (top, start).
fn placement(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let ds = Ds::get(cx);
    let room = || div().h(ds.len(Length::Space2xl));
    Stack::new()
        .gap(Space::Xxl)
        .child(
            DsBox::new()
                .padding_x(Space::Md)
                .radius(Radius::Panel)
                .border(Border::Hairline)
                .child(room())
                .child(room())
                .child(
                    Stack::row().justify(Justify::Center).child(
                        Tooltip::new("tooltip-placement")
                            .label(format!("{}: {} · {}", c.placed, c.top, c.start))
                            .side(Side::Top)
                            .align(Align::Start)
                            .open(true)
                            .child(
                                Button::new("tooltip-trigger")
                                    .variant(Variant::Outline)
                                    .size(Size::Sm)
                                    .text(c.trigger),
                            ),
                    ),
                )
                .child(room())
                .child(room()),
        )
        .child(Typo::caption(c.placement_hint).tone(Tone::Secondary))
        .into_any_element()
}

fn long_label(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    Tooltip::new("tooltip-long")
        .label(c.long)
        .child(
            Button::new("tooltip-long-trigger")
                .variant(Variant::Outline)
                .size(Size::Sm)
                .text(c.shortcut),
        )
        .into_any_element()
}
