//! IconTile.showcase.tsx. ProviderLogo is not a primitive of this batch: its slot is an empty
//! glyph-sized box.
use butler_ds::ui::Icon;
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::icon_slot::{IconSlot, SlotSize};
use butler_ds::ui::icon_tile::{IconTile, TileSize, TileTone};
use butler_ds::ui::layout::{Cross, Inline, Space, Stack};
use butler_ds::ui::thinking_mark::ButlerThinkingMark;
use butler_ds::ui::typo::{Role, Tone, Typo, Weight};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window};

use super::Story;
use crate::copy::Lang;

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Sizes and tones",
            render: sizes_and_tones,
        },
        Story {
            name: "A point in a consent list",
            render: consent_point,
        },
    ]
}

fn sizes_and_tones(_: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let ds = Ds::get(cx);
    Inline::new()
        .gap(Space::Md)
        .child(
            IconTile::new()
                .size(TileSize::Sm)
                .tone(TileTone::Accent)
                .child(icon(Icon::ShieldCheck, IconSize::Md, ds)),
        )
        .child(IconTile::new().child(IconSlot::new().size(SlotSize::Lg)))
        .child(
            IconTile::new()
                .size(TileSize::Lg)
                .child(icon(Icon::Globe2, IconSize::Xl, ds)),
        )
        .child(
            IconTile::new()
                .size(TileSize::Lg)
                .tone(TileTone::Danger)
                .child(icon(Icon::AlertCircle, IconSize::Xl, ds)),
        )
        .child(
            IconTile::new()
                .size(TileSize::Xl)
                .tone(TileTone::Plain)
                .mark(ButlerThinkingMark::new("tile-mark")),
        )
        .child(IconTile::new().child(icon(Icon::Monitor, IconSize::Lg, ds)))
        .into_any_element()
}

fn consent_point(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let ds = Ds::get(cx);
    let (title, body) = lang.pick(
        (
            "Asks before changing anything",
            "Butler asks before it edits files or runs commands.",
        ),
        (
            "바꾸기 전에 먼저 묻습니다",
            "파일을 고치거나 명령을 실행하기 전에 허락을 구합니다.",
        ),
    );
    Stack::row()
        .cross(Cross::Start)
        .gap(Space::Md)
        .child(
            IconTile::new()
                .size(TileSize::Sm)
                .tone(TileTone::Accent)
                .child(icon(Icon::ShieldCheck, IconSize::Md, ds)),
        )
        .child(
            Stack::new()
                .gap(Space::None)
                .child(Typo::new(Role::Label, title).weight(Weight::Semibold))
                .child(Typo::caption(body).tone(Tone::Secondary)),
        )
        .into_any_element()
}
