//! Switch.showcase.tsx. SettingsField is a stand-in (`standins.rs`).
use butler_ds::ui::card::{Card, CardPadding};
use butler_ds::ui::field::{Field, FieldContent, FieldDescription, FieldLabel, Orientation};
use butler_ds::ui::layout::{Cross, Space, Stack};
use butler_ds::ui::switch::{Size, Switch};
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window};

use super::{Story, probe};
use crate::copy::Lang;
use crate::standins::settings_field;

struct Copy {
    fallback: &'static str,
    fallback_hint: &'static str,
    developer: &'static str,
    developer_hint: &'static str,
    reduce_motion: &'static str,
    follows_system: &'static str,
    motion: &'static str,
    sandbox: &'static str,
    sandbox_hint: &'static str,
    unavailable: &'static str,
    reason_hint: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            fallback: "Use backup models",
            fallback_hint: "When the main model fails, Butler retries with the next model in the list.",
            developer: "Developer mode",
            developer_hint: "Only available in development builds.",
            reduce_motion: "Reduce motion",
            follows_system: "Follows the system setting",
            motion: "The thumb moves on --motion-base with the spring easing; reduced motion switches at once.",
            sandbox: "Command sandbox",
            sandbox_hint: "Runs commands that change files in an isolated environment.",
            unavailable: "Not available on this device",
            reason_hint: "Hover or focus the switch: the reason opens to its right, clear of the label and description.",
        },
        Copy {
            fallback: "예비 모델 사용",
            fallback_hint: "기본 모델이 실패하면 목록의 다음 모델로 다시 시도합니다.",
            developer: "개발자 모드",
            developer_hint: "개발 빌드에서만 사용할 수 있습니다.",
            reduce_motion: "동작 줄이기",
            follows_system: "시스템 설정을 따릅니다",
            motion: "손잡이는 --motion-base 동안 스프링 이징으로 움직이고, 동작 줄이기에서는 바로 바뀝니다.",
            sandbox: "명령 격리",
            sandbox_hint: "파일을 바꾸는 명령을 격리된 환경에서 실행합니다.",
            unavailable: "이 기기에서는 사용할 수 없습니다",
            reason_hint: "스위치에 올려 두거나 포커스하면 이유가 오른쪽에 열려 이름과 설명을 가리지 않습니다.",
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Placement: stacked switch field (default)",
            render: |lang, window, cx| {
                switch_field("switch-fallback-stacked", false, false, lang, window, cx)
            },
        },
        Story {
            name: "Placement: row switch field (phone or list item in a card)",
            render: |lang, window, cx| {
                switch_field("switch-fallback-row", false, true, lang, window, cx)
            },
        },
        Story {
            name: "Sizes and values",
            render: sizes,
        },
        Story {
            name: "Disabled (unavailable)",
            render: |lang, window, cx| {
                switch_field("switch-dev-stacked", true, false, lang, window, cx)
            },
        },
        Story {
            name: "Disabled with a reason (hover or focus)",
            render: reason,
        },
        Story {
            name: "Unavailable setting: reason opens to the right",
            render: sandbox,
        },
    ]
}

/// A switch field: stacked like an input (the default), or the row exception inside a card.
fn switch_field(
    id: &'static str,
    disabled: bool,
    row: bool,
    lang: Lang,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let c = copy(lang);
    let (label, hint) = if disabled {
        (c.developer, c.developer_hint)
    } else {
        (c.fallback, c.fallback_hint)
    };
    let state = window.use_keyed_state(id, cx, |_, _| true);
    let on = *state.read(cx);
    let mut control =
        Switch::new(id)
            .checked(on && !disabled)
            .on_checked_change(move |next, _, cx| {
                state.update(cx, |on, cx| {
                    *on = next;
                    cx.notify();
                });
            });
    if disabled {
        control = control.disabled();
    }
    let control = control.into_any_element();
    let marker = probe(format!(
        "checked-{id}-{}",
        if on && !disabled { "on" } else { "off" }
    ));
    let field = Field::new(format!("{id}-field"));
    if row {
        let content = field
            .orientation(Orientation::Horizontal)
            .content(
                FieldContent::new()
                    .child(FieldLabel::new().child(label))
                    .child(FieldDescription::new().child(hint)),
            )
            .child(control);
        return Card::new("switch-card")
            .padding(CardPadding::Md)
            .child(content)
            .child(marker)
            .into_any_element();
    }
    field
        .child(FieldLabel::new().child(label))
        .child(FieldDescription::new().child(hint))
        .child(control)
        .child(marker)
        .into_any_element()
}

fn sizes(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    let mut rows = Stack::new().gap(Space::Sm);
    for (size, name) in [(Size::Default, "default"), (Size::Sm, "sm")] {
        rows = rows.child(
            Stack::new()
                .gap(Space::Xs)
                .child(Typo::caption(name).tone(Tone::Secondary))
                .child(
                    Stack::row()
                        .cross(Cross::Center)
                        .gap(Space::Md)
                        .child(
                            Switch::new(format!("switch-on-{name}"))
                                .size(size)
                                .default_checked(true),
                        )
                        .child(Switch::new(format!("switch-off-{name}")).size(size)),
                ),
        );
    }
    rows.child(Typo::caption(c.motion).tone(Tone::Secondary))
        .into_any_element()
}

fn reason(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    Field::new("switch-reduce-field")
        .child(FieldLabel::new().child(c.reduce_motion))
        .child(
            Switch::new("switch-reduce-motion")
                .checked(true)
                .disabled_reason(c.follows_system),
        )
        .into_any_element()
}

fn sandbox(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    Stack::new()
        .gap(Space::Md)
        .child(settings_field(
            c.sandbox,
            c.sandbox_hint,
            Switch::new("switch-sandbox")
                .checked(false)
                .disabled_reason(c.unavailable)
                .into_any_element(),
            cx,
        ))
        .child(Typo::caption(c.reason_hint).tone(Tone::Secondary))
        .into_any_element()
}
