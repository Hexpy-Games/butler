//! Tooltip.showcase.tsx. SettingsField is a stand-in (`standins.rs`); "Why a control is
//! unavailable" needs the ComposerControl block and stays out.
use butler_ds::tokens::Length;
use butler_ds::ui::Icon;
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::icon_button::IconButton;
use butler_ds::ui::layout::{Border, Box as DsBox, Justify, Radius, Space, Stack};
use butler_ds::ui::segmented_control::{Choice, SegmentedControl, Size as SegmentSize};
use butler_ds::ui::switch::Switch;
use butler_ds::ui::tooltip::{Align, Side, Tooltip};
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Styled as _, Window, div};

use super::{Story, probe};
use crate::copy::Lang;
use crate::standins::settings_field;

struct Copy {
    hint: &'static str,
    panel: &'static str,
    shortcut: &'static str,
    long: &'static str,
    trigger: &'static str,
    placed: &'static str,
    side: &'static str,
    align: &'static str,
    sides: [&'static str; 4],
    aligns: [&'static str; 3],
    placement_hint: &'static str,
    sandbox: &'static str,
    sandbox_hint: &'static str,
    unavailable: &'static str,
    field_hint: &'static str,
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
            side: "Side",
            align: "Align",
            sides: ["Top", "Right", "Bottom", "Left"],
            aligns: ["Start", "Center", "End"],
            placement_hint: "Shown open here. Without room it flips to the other side and shifts to stay on screen.",
            sandbox: "Command sandbox",
            sandbox_hint: "Runs commands that change files in an isolated environment.",
            unavailable: "Not available on this device",
            field_hint: "A disabled reason opens to the right, clear of the label and description above the control.",
        },
        Copy {
            hint: "650ms 동안 올려 두거나 키보드로 포커스하세요. 툴팁은 컨트롤 이름만 보여 주며 동작을 담지 않습니다.",
            panel: "오른쪽 패널 보기",
            shortcut: "링크 복사",
            long: "대화를 그대로 둔 채 오른쪽 패널에서 프로젝트 대시보드를 엽니다",
            trigger: "기준",
            placed: "여기에 열림",
            side: "방향",
            align: "정렬",
            sides: ["위", "오른쪽", "아래", "왼쪽"],
            aligns: ["시작", "가운데", "끝"],
            placement_hint: "여기서는 열린 채로 보입니다. 자리가 없으면 반대쪽으로 넘어가고 화면 안으로 밀려 들어옵니다.",
            sandbox: "명령 격리",
            sandbox_hint: "파일을 바꾸는 명령을 격리된 환경에서 실행합니다.",
            unavailable: "이 기기에서는 사용할 수 없습니다",
            field_hint: "사용할 수 없는 이유는 컨트롤 오른쪽에 열려 위의 이름과 설명을 가리지 않습니다.",
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
            name: "Disabled reason beside a settings control",
            render: reason_beside_field,
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

const SIDES: [(Side, &str); 4] = [
    (Side::Top, "top"),
    (Side::Right, "right"),
    (Side::Bottom, "bottom"),
    (Side::Left, "left"),
];
const ALIGNS: [(Align, &str); 3] = [
    (Align::Start, "start"),
    (Align::Center, "center"),
    (Align::End, "end"),
];

/// A selector's held choice and the handler that changes it.
fn selected(
    id: &'static str,
    initial: &'static str,
    window: &mut Window,
    cx: &mut App,
) -> (
    gpui::SharedString,
    impl Fn(&str, &mut Window, &mut App) + 'static,
) {
    let state = window.use_keyed_state(id, cx, move |_, _| gpui::SharedString::from(initial));
    let value = state.read(cx).clone();
    (value, move |next: &str, _: &mut Window, cx: &mut App| {
        let next = gpui::SharedString::from(next.to_owned());
        state.update(cx, |value, cx| {
            *value = next;
            cx.notify();
        });
    })
}

/// Every side x align, open, around one trigger.
fn placement(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let (side, on_side) = selected("tooltip-side", "top", window, cx);
    let (align, on_align) = selected("tooltip-align", "start", window, cx);
    let at = |name: &str| SIDES.iter().position(|(_, n)| *n == name).unwrap_or(0);
    let side_index = at(&side);
    let align_index = ALIGNS.iter().position(|(_, n)| *n == &*align).unwrap_or(0);
    let ds = Ds::get(cx);
    let room = || div().h(ds.len(Length::Space2xl));
    Stack::new()
        .gap(Space::Xxl)
        .child(
            Stack::row()
                .wrap(true)
                .gap(Space::Md)
                .child(
                    SegmentedControl::new("tooltip-side-control", c.side, side.clone())
                        .size(SegmentSize::Sm)
                        .options(
                            SIDES
                                .iter()
                                .zip(c.sides)
                                .map(|((_, v), l)| Choice::new(*v, l)),
                        )
                        .on_value_change(on_side),
                )
                .child(
                    SegmentedControl::new("tooltip-align-control", c.align, align.clone())
                        .size(SegmentSize::Sm)
                        .options(
                            ALIGNS
                                .iter()
                                .zip(c.aligns)
                                .map(|((_, v), l)| Choice::new(*v, l)),
                        )
                        .on_value_change(on_align),
                ),
        )
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
                            .label(format!(
                                "{}: {} · {}",
                                c.placed, c.sides[side_index], c.aligns[align_index]
                            ))
                            .side(SIDES[side_index].0)
                            .align(ALIGNS[align_index].0)
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
        .child(probe(format!("placement-{side}-{align}")))
        .into_any_element()
}

/// What Switch `disabledReason` does in a stacked SettingsField, shown open.
fn reason_beside_field(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    Stack::new()
        .gap(Space::Md)
        .child(settings_field(
            c.sandbox,
            c.sandbox_hint,
            Tooltip::new("tooltip-sandbox")
                .label(c.unavailable)
                .side(Side::Right)
                .open(true)
                .child(
                    Switch::new("tooltip-sandbox-switch")
                        .checked(false)
                        .disabled(),
                )
                .into_any_element(),
            cx,
        ))
        .child(Typo::caption(c.field_hint).tone(Tone::Secondary))
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
