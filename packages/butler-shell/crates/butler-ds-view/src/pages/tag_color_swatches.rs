//! TagColorSwatches.showcase.tsx: a new tag's colour (the swatches and the Tag they restyle),
//! a shorter list of tones, and the picker on the wallpaper stages (drawn without the live
//! wallpaper, as in the Tag page).
use butler_ds::tokens::Length;
use butler_ds::ui::blocks::tag_color_swatches::TagColorSwatches;
use butler_ds::ui::context::Ds;
use butler_ds::ui::layout::{Columns, Grid, Space, Stack};
use butler_ds::ui::tag::{LabelTone, Tag, Tone};
use butler_ds::ui::tinted_glass::{GlassPadding, GlassRadius, TintedGlass};
use gpui::{
    AnyElement, App, IntoElement as _, ParentElement as _, SharedString, Styled as _, Window, div,
};

use super::{Story, sub};
use crate::copy::Lang;

fn tag_text(lang: Lang) -> &'static str {
    lang.pick("design", "디자인")
}

fn tone_name(lang: Lang, tone: LabelTone) -> SharedString {
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
    lang.pick(en, ko).into()
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Pick a tone",
            render: |lang, window, cx| picker("tcs-pick", LabelTone::Blue, lang, window, cx),
        },
        Story {
            name: "Fewer tones",
            render: fewer,
        },
        Story {
            name: "On wallpaper",
            render: on_wallpaper,
        },
    ]
}

/// A new tag's colour: the swatches and the Tag they restyle.
fn picker(
    id: &'static str,
    initial: LabelTone,
    lang: Lang,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let tone = window.use_keyed_state(sub(id, "tone"), cx, move |_, _| initial);
    let value = *tone.read(cx);
    Stack::new()
        .gap(Space::Sm)
        .child(
            TagColorSwatches::new(id, value)
                .labels(move |t| tone_name(lang, t))
                .on_value_change(move |next, _, cx| {
                    tone.update(cx, |tone, cx| {
                        *tone = next;
                        cx.notify();
                    });
                }),
        )
        .child(Tag::new(sub(id, "tag"), tag_text(lang)).tone(Tone::Label(value)))
        .into_any_element()
}

fn fewer(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    TagColorSwatches::new("tcs-fewer", LabelTone::Green)
        .tones([
            LabelTone::Gray,
            LabelTone::Red,
            LabelTone::Green,
            LabelTone::Blue,
        ])
        .labels(move |t| tone_name(lang, t))
        .into_any_element()
}

/// `OnWallpapers`: the picker flat on each stage, then again on glass over it.
fn on_wallpaper(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let mut stages = Grid::new("tcs-stages")
        .columns(Columns::AUTO_FIT)
        .gap(Space::Md);
    for (key, glass) in [
        ("tcs-riso", "tcs-riso-glass"),
        ("tcs-photo", "tcs-photo-glass"),
    ] {
        let flat = picker(key, LabelTone::Teal, lang, window, cx);
        let on_glass = picker(glass, LabelTone::Teal, lang, window, cx);
        let ds = Ds::get(cx);
        stages = stages.child(
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
                        .child(flat)
                        .child(
                            TintedGlass::new()
                                .padding(GlassPadding::Sm)
                                .radius(GlassRadius::Control)
                                .child(on_glass),
                        ),
                ),
        );
    }
    stages.into_any_element()
}
