//! PillButton.showcase.tsx.
use butler_ds::ui::Icon;
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::layout::{Cross, Justify, MinWidth, Space, Stack, WithItem as _};
use butler_ds::ui::pill_button::{PillButton, Surface};
use butler_ds::ui::typo::{Tone, Typo, Wrap};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window};

use super::Story;
use crate::copy::Lang;

struct Copy {
    report: &'static str,
    task: &'static str,
    activity: &'static str,
    progress: &'static str,
    attach: &'static str,
    stretch: &'static str,
    chips: [(&'static str, u32); 4],
    new_group: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            report: "Preparing report: Q3 release retro",
            task: "Migrate settings pages",
            activity: "Editing SettingsSection",
            progress: "2/4",
            attach: "Add context",
            stretch: "Stretched capsule fills its row",
            chips: [
                ("All", 14),
                ("Travel", 5),
                ("Recipes", 2),
                ("Gift ideas", 0),
            ],
            new_group: "New group",
        },
        Copy {
            report: "보고서 준비 중: 3분기 릴리스 회고",
            task: "설정 페이지 이전",
            activity: "SettingsSection 편집 중",
            progress: "2/4",
            attach: "맥락 추가",
            stretch: "늘어난 캡슐은 행을 채웁니다",
            chips: [
                ("전체", 14),
                ("여행", 5),
                ("레시피", 2),
                ("선물 아이디어", 0),
            ],
            new_group: "새 그룹",
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Plain",
            render: plain,
        },
        Story {
            name: "Glass capsules (composer)",
            render: glass,
        },
        Story {
            name: "Chips: pressed, count, drop target",
            render: chips,
        },
        Story {
            name: "Stretch",
            render: stretch,
        },
        Story {
            name: "Disabled (report not ready)",
            render: disabled,
        },
    ]
}

fn plain(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    PillButton::new("pill-plain")
        .icon(icon(Icon::Plus, IconSize::Md, Ds::get(cx)))
        .text(copy(lang).attach)
        .on_click(|_, _, _| {})
        .into_any_element()
}

/// Steward progress capsule above the composer: task, activity, progress.
fn capsule(c: &Copy, disabled: bool, cx: &App) -> PillButton {
    let dot = || Typo::text("·").tone(Tone::Tertiary).wrap(Wrap::Nowrap);
    let capsule = PillButton::new("pill-progress")
        .surface(Surface::Glass)
        .icon(icon(Icon::Sparkles, IconSize::Md, Ds::get(cx)))
        .on_click(|_, _, _| {})
        .child(
            Stack::row()
                .cross(Cross::Center)
                .gap(Space::Xs)
                .min_width(MinWidth::Zero)
                .child(Typo::text(c.task).truncate())
                .child(dot())
                .child(Typo::text(c.activity).tone(Tone::Secondary).truncate())
                .child(dot())
                .child(
                    Typo::text(c.progress)
                        .tone(Tone::Secondary)
                        .wrap(Wrap::Nowrap),
                ),
        );
    if disabled {
        capsule.disabled()
    } else {
        capsule
    }
}

fn glass(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    Stack::row()
        .gap(Space::Sm)
        .justify(Justify::Center)
        .wrap(true)
        .child(
            PillButton::new("pill-report")
                .surface(Surface::Glass)
                .icon(icon(Icon::Sparkles, IconSize::Md, Ds::get(cx)))
                .text(c.report)
                .on_click(|_, _, _| {}),
        )
        .child(capsule(&c, false, cx))
        .into_any_element()
}

fn chips(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let c = copy(lang);
    let mut row = Stack::row().gap(Space::Xs).wrap(true);
    for (index, (name, count)) in c.chips.iter().enumerate() {
        let mut chip = PillButton::new(format!("pill-chip-{index}"))
            .text(*name)
            .pressed(index == 1)
            .on_click(|_, _, _| {});
        if index == 2 {
            chip = chip.drop_target();
        }
        if *count > 0 {
            chip = chip.count(count.to_string());
        }
        row = row.child(chip);
    }
    row.child(
        PillButton::new("pill-new-group")
            .icon(icon(Icon::Plus, IconSize::Sm, Ds::get(cx)))
            .text(c.new_group)
            .on_click(|_, _, _| {}),
    )
    .into_any_element()
}

fn stretch(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    PillButton::new("pill-stretch")
        .stretch()
        .icon(icon(Icon::Plus, IconSize::Md, Ds::get(cx)))
        .text(copy(lang).stretch)
        .into_any_element()
}

fn disabled(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    PillButton::new("pill-disabled")
        .disabled()
        .surface(Surface::Glass)
        .icon(icon(Icon::Sparkles, IconSize::Md, Ds::get(cx)))
        .text(copy(lang).report)
        .into_any_element()
}
