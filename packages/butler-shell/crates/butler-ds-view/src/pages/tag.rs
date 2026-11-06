//! Tag.showcase.tsx. The "Label tones on wallpaper" story draws its stages and the glass over
//! them, without the live wallpaper (the WebGL wallpaper is a later batch).
use butler_ds::tokens::Length;
use butler_ds::ui::Icon;
use butler_ds::ui::context::Ds;
use butler_ds::ui::dropdown_menu::{Item, Variant as ItemVariant};
use butler_ds::ui::layout::{Columns, Grid, Inline, Space};
use butler_ds::ui::tag::{LabelTone, Size, Tag, Tone};
use butler_ds::ui::tinted_glass::{GlassPadding, GlassRadius, TintedGlass};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Styled as _, Window, div};

use super::Story;
use crate::copy::Lang;

struct Copy {
    neutral: &'static str,
    accent: &'static str,
    success: &'static str,
    warning: &'static str,
    danger: &'static str,
    remove: &'static str,
    remove_design: &'static str,
    eyebrow: &'static str,
    label: &'static str,
    edit: &'static str,
    rename: &'static str,
    recolor: &'static str,
    delete: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            neutral: "Draft",
            accent: "Plan",
            success: "Done",
            warning: "Needs review",
            danger: "Failed",
            remove: "Remove plan mode",
            remove_design: "Remove design",
            eyebrow: "Foundations · 196 tokens",
            label: "design",
            edit: "design tag menu",
            rename: "Rename",
            recolor: "Change color",
            delete: "Delete",
        },
        Copy {
            neutral: "초안",
            accent: "계획",
            success: "완료",
            warning: "검토 필요",
            danger: "실패",
            remove: "계획 모드 해제",
            remove_design: "디자인 빼기",
            eyebrow: "기초 · 토큰 196개",
            label: "디자인",
            edit: "디자인 태그 메뉴",
            rename: "이름 바꾸기",
            recolor: "색 바꾸기",
            delete: "삭제",
        },
    )
}

fn tone_name(lang: Lang, tone: LabelTone) -> &'static str {
    let (en, ko) = match tone {
        LabelTone::Gray => ("Gray", "회색"),
        LabelTone::Red => ("Red", "빨강"),
        LabelTone::Orange => ("Orange", "주황"),
        LabelTone::Yellow => ("Yellow", "노랑"),
        LabelTone::Green => ("Green", "초록"),
        LabelTone::Teal => ("Teal", "청록"),
        LabelTone::Blue => ("Blue", "파랑"),
        LabelTone::Purple => ("Purple", "보라"),
    };
    lang.pick(en, ko)
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Tones",
            render: tones,
        },
        Story {
            name: "Label tones",
            render: |lang, _, _| label_tones("tag-label", lang),
        },
        Story {
            name: "Label tones on wallpaper",
            render: on_wallpaper,
        },
        Story {
            name: "Sizes",
            render: sizes,
        },
        Story {
            name: "With icon",
            render: with_icon,
        },
        Story {
            name: "Trailing icon",
            render: trailing_icon,
        },
        Story {
            name: "Removable",
            render: removable,
        },
        Story {
            name: "Editable",
            render: editable,
        },
    ]
}

fn tones(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    Inline::new()
        .child(Tag::new("tag-neutral", c.neutral))
        .child(Tag::new("tag-accent", c.accent).tone(Tone::Accent))
        .child(Tag::new("tag-success", c.success).tone(Tone::Success))
        .child(Tag::new("tag-warning", c.warning).tone(Tone::Warning))
        .child(Tag::new("tag-danger", c.danger).tone(Tone::Danger))
        .into_any_element()
}

fn label_tones(key: &str, lang: Lang) -> AnyElement {
    Inline::new()
        .children(LabelTone::ALL.map(|tone| {
            Tag::new(format!("{key}-{tone:?}"), tone_name(lang, tone)).tone(Tone::Label(tone))
        }))
        .into_any_element()
}

/// `OnWallpapers`: the tones flat on each stage, then again on glass over it.
fn on_wallpaper(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let ds = Ds::get(cx);
    let stage = |key: &'static str| {
        div()
            .relative()
            .overflow_hidden()
            .rounded(ds.len(Length::RadiusPanel))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(ds.len(Length::SpaceMd))
                    .p(ds.len(Length::SpaceLg))
                    .child(label_tones(key, lang))
                    .child(
                        TintedGlass::new()
                            .padding(GlassPadding::Sm)
                            .radius(GlassRadius::Control)
                            .child(label_tones(&format!("{key}-glass"), lang)),
                    ),
            )
    };
    Grid::new("tag-stages")
        .columns(Columns::AUTO_FIT)
        .gap(Space::Md)
        .child(stage("tag-riso"))
        .child(stage("tag-photo"))
        .into_any_element()
}

fn sizes(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    Inline::new()
        .child(Tag::new("tag-size-sm", c.neutral))
        .child(Tag::new("tag-size-md", c.neutral).size(Size::Md))
        .child(
            Tag::new("tag-size-sm-icon", c.accent)
                .tone(Tone::Accent)
                .icon(Icon::ListChecks),
        )
        .child(
            Tag::new("tag-size-md-icon", c.accent)
                .tone(Tone::Accent)
                .size(Size::Md)
                .icon(Icon::ListChecks),
        )
        .child(
            Tag::new("tag-size-md-eyebrow", c.eyebrow)
                .tone(Tone::Accent)
                .size(Size::Md),
        )
        .into_any_element()
}

fn with_icon(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    Inline::new()
        .child(Tag::new("tag-icon-plan", c.accent).icon(Icon::ListChecks))
        .child(
            Tag::new("tag-icon-done", c.success)
                .tone(Tone::Success)
                .icon(Icon::CheckCircle2),
        )
        .child(
            Tag::new("tag-icon-failed", c.danger)
                .tone(Tone::Danger)
                .icon(Icon::CircleAlert),
        )
        .into_any_element()
}

fn trailing_icon(_: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    Inline::new()
        .child(Tag::new("tag-end-4", "+4").icon_end(Icon::ChevronRight))
        .child(Tag::new("tag-end-12", "+12").icon_end(Icon::ChevronRight))
        .child(
            Tag::new("tag-end-md", "+4")
                .size(Size::Md)
                .icon_end(Icon::ChevronRight),
        )
        .into_any_element()
}

fn removable(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    Tag::new("tag-removable", c.accent)
        .icon(Icon::ListChecks)
        .on_remove(c.remove, |_, _, _| {})
        .into_any_element()
}

/// CanonTagsField: an attached label in an editable field, with its edit menu before remove.
fn editable(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    Inline::new()
        .child(
            Tag::new("tag-editable", c.label)
                .tone(Tone::Label(LabelTone::Teal))
                .on_remove(c.remove_design, |_, _, _| {})
                .edit_menu(
                    c.edit,
                    vec![
                        Item::new(c.rename).into(),
                        Item::new(c.recolor).into(),
                        Item::new(c.delete).variant(ItemVariant::Destructive).into(),
                    ],
                ),
        )
        .child(Tag::new("tag-plain", c.label).tone(Tone::Label(LabelTone::Teal)))
        .into_any_element()
}
