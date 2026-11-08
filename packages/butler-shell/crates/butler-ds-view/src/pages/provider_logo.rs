//! ProviderLogo.showcase.tsx: every logo in a tile, monochrome and colour logos, and the sizes.
use butler_ds::ui::icon_tile::IconTile;
use butler_ds::ui::layout::{Inline, Space, Stack};
use butler_ds::ui::provider_logo::{ProviderLogo, ProviderLogoName, ProviderLogoSize};
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window};

use super::Story;
use crate::copy::Lang;

struct Copy {
    mono: &'static str,
    color: &'static str,
    size: &'static str,
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            mono: "Monochrome logos follow the text color",
            color: "Color logos keep their own fills",
            size: "Sizes",
        },
        Copy {
            mono: "단색 로고는 글자색을 따릅니다",
            color: "색 로고는 원래 색을 유지합니다",
            size: "크기",
        },
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Every logo in a tile",
            render: tiles,
        },
        Story {
            name: "Monochrome and color",
            render: tones,
        },
        Story {
            name: "Sizes",
            render: sizes,
        },
    ]
}

fn tiles(_: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    Inline::new()
        .gap(Space::Sm)
        .children(ProviderLogoName::ALL.map(|name| {
            IconTile::new().child(
                ProviderLogo::new(name)
                    .size(ProviderLogoSize::Lg)
                    .label(name.key()),
            )
        }))
        .into_any_element()
}

fn tones(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    let logo = |name: ProviderLogoName| ProviderLogo::new(name).size(ProviderLogoSize::Lg);
    let (colored, mono): (Vec<_>, Vec<_>) = ProviderLogoName::ALL
        .into_iter()
        .partition(|name| !name.is_mono());
    let mono_row = Inline::new()
        .gap(Space::Md)
        .children(mono.into_iter().map(logo));
    // React lists the colour row as claude, gemini, qwen, deepseek, upstage (no anthropic).
    let color_row = Inline::new().gap(Space::Md).children(
        colored
            .into_iter()
            .filter(|name| *name != ProviderLogoName::Anthropic)
            .map(logo),
    );
    Stack::new()
        .gap(Space::Sm)
        .child(Typo::caption(c.mono).tone(Tone::Secondary))
        .child(mono_row)
        .child(Typo::caption(c.color).tone(Tone::Secondary))
        .child(color_row)
        .into_any_element()
}

fn sizes(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let c = copy(lang);
    let at = |size| ProviderLogo::new(ProviderLogoName::OpenAi).size(size);
    Stack::new()
        .gap(Space::Sm)
        .child(Typo::caption(c.size).tone(Tone::Secondary))
        .child(
            Inline::new()
                .gap(Space::Md)
                .child(at(ProviderLogoSize::Sm))
                .child(at(ProviderLogoSize::Md))
                .child(at(ProviderLogoSize::Lg)),
        )
        .into_any_element()
}
