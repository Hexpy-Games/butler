//! The parts of an ItemCard: body, picture, text with its Show more, and the footer.
use gpui::{
    AnyElement, App, ElementId, Entity, InteractiveElement as _, IntoElement, ParentElement,
    SharedString, StatefulInteractiveElement as _, Styled as _, Window, canvas, div, px,
};

use super::{ItemCard, ItemSource, ItemValue, own_target};
use crate::tokens::{Color, Length};
use crate::ui::Icon;
use crate::ui::button::{self, Button, Size, Variant};
use crate::ui::clickable::{Clickable, Variant as ClickVariant};
use crate::ui::context::Ds;
use crate::ui::convert;
use crate::ui::icon::{IconSize, icon};
use crate::ui::icon_slot::{IconSlot, SlotSize, SlotTone};
use crate::ui::layout::Space;
use crate::ui::tag::{Size as TagSize, Tag, Tone as TagTone};
use crate::ui::typo::{Tone, Typo, Weight, Wrap};

/// Which part of the card the pointer is on: the picture button, Show more, the source and the
/// actions. The card's hover (open the item) drops while it is on one of them.
pub(super) type Parts = Entity<[bool; 4]>;
const MEDIA: usize = 0;
const MORE: usize = 1;
const SOURCE: usize = 2;
const ACTIONS: usize = 3;

/// The row card's picture column and the gap beside it (112px + `--space-md`).
const ROW_MEDIA_COLUMN: f32 = 128.;

/// `filter: brightness(0.94)` on the hovered picture, as a black veil.
const DIM: f32 = 0.06; // DS: ItemCard.module.css:98

/// `.textBlock` and `.text`: the clamp of a vertical card.
const TEXT_CLAMP: usize = 4; // DS: ItemCard.tsx `--item-card-text-clamp: 4`

/// Marks the part under the pointer in `parts`.
fn tracked(
    part: gpui::Stateful<gpui::Div>,
    parts: &Parts,
    which: usize,
) -> gpui::Stateful<gpui::Div> {
    let parts = parts.clone();
    part.on_hover(move |on, _, cx| {
        parts.update(cx, |parts, cx| {
            parts[which] = *on;
            cx.notify();
        });
    })
}

pub(super) fn body(
    card: &mut ItemCard,
    (row, width): (bool, f32),
    parts: &Parts,
    window: &mut Window,
    cx: &mut App,
) -> gpui::Div {
    let ds = Ds::get(cx);
    let inset = if row && card.media.is_some() {
        px(0.)
    } else {
        ds.len(Length::SpaceXs)
    };
    let mut body = div()
        .flex()
        .flex_col()
        .flex_1()
        .min_w_0()
        .gap(ds.len(Length::SpaceXs))
        .px(inset);
    if let Some(eyebrow) = card.eyebrow.take() {
        body = body.child(
            div().flex().min_w_0().overflow_hidden().child(
                Tag::new((card.id.clone(), "eyebrow"), eyebrow)
                    .tone(TagTone::Accent)
                    .size(TagSize::Sm),
            ),
        );
    }
    if let Some(subtitle) = card.subtitle.take() {
        body = body.child(Typo::caption(subtitle).tone(Tone::Tertiary).truncate());
    }
    let media_col = if row && card.media.is_some() {
        ROW_MEDIA_COLUMN
    } else {
        0.
    };
    let room =
        width - 2. * (f32::from(ds.len(Length::Space2)) + 1.) - 2. * f32::from(inset) - media_col;
    body = body.child(title(card, room, ds));
    if let Some(value) = card.value.take() {
        body = body.child(value_block(value));
    }
    if !card.facts.is_empty() {
        body = body.child(facts(&card.facts, ds));
    }
    if let Some(text) = text_block(card, row, parts, window, cx) {
        body = body.child(text);
    }
    body
}

/// The title: two lines at `--font-size-3`; with `on_open` it is a bare-text Clickable, the
/// card's one tab stop.
fn title(card: &ItemCard, room: f32, ds: &Ds) -> AnyElement {
    // A bare-text Clickable sizes to its content, so the title takes the body's width itself.
    let sized = div();
    let heading = if room > 0. {
        sized.w(px(room))
    } else {
        sized.w_full()
    }
    .min_w_0()
    .whitespace_normal()
    .text_ellipsis()
    .text_size(ds.len(Length::FontSize3))
    .line_height(ds.len(Length::TypoBodyLineHeight))
    .child(
        Typo::text(card.title.clone())
            .weight(Weight::Semibold)
            .line_clamp(2),
    );
    let Some(open) = card.on_open.clone() else {
        return heading.into_any_element();
    };
    own_target(
        div().w_full().min_w_0().child(
            Clickable::new((card.id.clone(), "open"))
                .variant(ClickVariant::Text)
                .on_click(move |event, window, cx| open(event, window, cx))
                .child(heading),
        ),
    )
    .into_any_element()
}

fn value_block(value: ItemValue) -> gpui::Div {
    let ds_amounts = div()
        .flex()
        .flex_wrap()
        .items_baseline()
        .min_w_0()
        .gap_x(px(8.)) // `column-gap: var(--space-sm)`
        .child(Typo::metric_value(value.amount).tabular());
    let amounts = match value.was {
        Some(was) => ds_amounts.child(
            div()
                .line_through()
                .child(Typo::caption(was).tone(Tone::Tertiary).tabular()),
        ),
        None => ds_amounts,
    };
    div().flex().flex_col().min_w_0().child(amounts).children(
        value
            .note
            .map(|note| Typo::caption(note).tone(Tone::Secondary)),
    )
}

/// One dot-separated line that wraps whole facts: the dot belongs to the fact before it.
fn facts(facts: &[SharedString], ds: &Ds) -> gpui::Div {
    let last = facts.len() - 1;
    div()
        .flex()
        .flex_wrap()
        .min_w_0()
        .text_color(ds.color(Color::TextSecondary))
        .children(facts.iter().enumerate().map(|(index, fact)| {
            let mut item = div().flex().min_w_0().child(
                Typo::caption(fact.clone())
                    .tone(Tone::Inherit)
                    .wrap(Wrap::Anywhere),
            );
            if index < last {
                item = item.child(
                    div()
                        .mx(ds.len(Length::SpaceXs))
                        .text_color(ds.color(Color::TextTertiary))
                        .child(Typo::caption("·").tone(Tone::Inherit)),
                );
            }
            item
        }))
}

/// The paragraph at `--font-size-2` / label line height, secondary, wrapping anywhere.
fn paragraph(text: &SharedString, clamp: Option<usize>, ds: &Ds) -> gpui::Div {
    let mut typo = Typo::text(text.clone());
    if let Some(lines) = clamp {
        typo = typo.line_clamp(lines);
    }
    div()
        .w_full()
        .min_w_0()
        .text_size(ds.len(Length::FontSize2))
        .line_height(ds.len(Length::TypoLabelLineHeight))
        .text_color(ds.color(Color::TextSecondary))
        .text_ellipsis()
        .child(typo)
}

/// The card's plain text. A vertical card clamps it; with both labels Show more reveals the
/// rest when it really overflows. A row card shows it whole.
fn text_block(
    card: &ItemCard,
    row: bool,
    parts: &Parts,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    let text = card.text.as_ref()?;
    let id = card.id.clone();
    let expanded = window.use_keyed_state((id.clone(), "expanded"), cx, |_, _| false);
    let full = window.use_keyed_state((id.clone(), "full"), cx, |_, _| 0f32);
    let ds = Ds::get(cx);
    let line = f32::from(ds.len(Length::TypoLabelLineHeight));
    let open = *expanded.read(cx);
    let clampable =
        card.toggle_labels.is_some() && !row && *full.read(cx) > line * TEXT_CLAMP as f32 + 1.;
    let clamp = (!row && !open).then_some(TEXT_CLAMP);
    let probe = full.clone();
    let measuring = div()
        .absolute()
        .top_0()
        .left_0()
        .w_full()
        .invisible()
        .child(paragraph(text, None, ds))
        .child(
            canvas(
                move |bounds, _, cx| {
                    let height = f32::from(bounds.size.height);
                    probe.update(cx, |full, cx| {
                        if (*full - height).abs() > 0.5 {
                            *full = height;
                            cx.notify();
                        }
                    });
                },
                |_, (), _, _| {},
            )
            .absolute()
            .size_full(),
        );
    let mut block = div()
        .relative()
        .flex()
        .flex_col()
        .items_start()
        .min_w_0()
        .mt(ds.len(Length::SpaceXs))
        .child(measuring)
        .child(paragraph(text, clamp, ds));
    if let (true, Some((more, less))) = (clampable, card.toggle_labels.as_ref()) {
        let label = if open { less.clone() } else { more.clone() };
        let toggle = Button::new((id.clone(), "toggle"))
            .variant(Variant::Inline)
            .text(label)
            .on_click(move |_, _, cx| {
                expanded.update(cx, |open, cx| {
                    *open = !*open;
                    cx.notify();
                });
            });
        block = block.child(tracked(
            own_target(div())
                .id((id.clone(), "toggle-part"))
                .child(toggle),
            parts,
            MORE,
        ));
    }
    Some(block.into_any_element())
}

/// The picture: with `on_media_open` its own bare-text button that dims on hover.
pub(super) fn media(
    id: &ElementId,
    media: AnyElement,
    card: &mut ItemCard,
    (parts, hovered): (&Parts, bool),
) -> AnyElement {
    let Some(open) = card.on_media_open.clone() else {
        return media;
    };
    let dim = hovered.then(|| {
        div()
            .absolute()
            .size_full()
            .top_0()
            .left_0()
            .bg(convert::with_alpha(gpui::black(), DIM))
    });
    let picture = div().relative().w_full().child(media).children(dim);
    let button = Clickable::new((id.clone(), "media"))
        .variant(ClickVariant::Text)
        .stretch()
        .on_click(move |event, window, cx| open(event, window, cx))
        .child(picture);
    tracked(
        own_target(div().min_w_0())
            .id((id.clone(), "media-part"))
            .child(button),
        parts,
        MEDIA,
    )
    .into_any_element()
}

/// The footer: the source line and the actions, under a hairline.
pub(super) fn footer(
    card: &mut ItemCard,
    row: bool,
    parts: &Parts,
    _window: &mut Window,
    cx: &mut App,
) -> Option<gpui::Div> {
    if card.source.is_none() && card.actions.is_empty() {
        return None;
    }
    let ds = Ds::get(cx);
    let id = card.id.clone();
    let source = match card.source.take() {
        Some(source) => source_line(&id, source, row, parts, ds),
        None => div().flex_1().into_any_element(),
    };
    let mut footer = div()
        .flex()
        .items_center()
        .min_w_0()
        .gap(ds.len(Length::SpaceXs))
        .pt(ds.len(Length::SpaceXs))
        .pl(ds.len(Length::SpaceXs))
        .border_t(ds.len(Length::BorderHairline))
        .border_color(ds.color(Color::Line))
        .child(source);
    if !card.actions.is_empty() {
        let mut actions = button::container(Size::IconSm);
        if !row {
            actions = actions.gap(Space::Xs);
        }
        let actions = std::mem::take(&mut card.actions)
            .into_iter()
            .fold(actions, gpui::ParentElement::child);
        footer = footer.child(tracked(
            own_target(div().flex_none())
                .id((id, "actions"))
                .child(actions),
            parts,
            ACTIONS,
        ));
    }
    Some(footer)
}

/// SiteIcon: a favicon in a 16px slot, a tertiary globe without one.
fn site_icon(source: Option<gpui::ImageSource>, ds: &Ds) -> AnyElement {
    let slot = IconSlot::new().size(SlotSize::Md);
    match source {
        Some(source) => slot
            .child(gpui::img(source).w(px(16.)).h(px(16.)))
            .into_any_element(),
        None => slot
            .tone(SlotTone::Tertiary)
            .child(icon(Icon::Globe2, IconSize::Md, ds))
            .into_any_element(),
    }
}

fn source_line(
    id: &ElementId,
    source: ItemSource,
    row: bool,
    parts: &Parts,
    ds: &Ds,
) -> AnyElement {
    let text = match (&source.checked, row) {
        (Some(checked), true) => format!("{} · {checked}", source.site),
        (Some(checked), false) => checked.to_string(),
        (None, _) => source.site.to_string(),
    };
    let on_open = source.on_open.clone();
    let mut label = div()
        .flex()
        .flex_1()
        .min_w_0()
        .items_center()
        .gap(ds.len(Length::SpaceSm));
    if row {
        label = label.child(site_icon(source.icon, ds));
    }
    label = label.child(
        div()
            .min_w_0()
            .child(Typo::caption(text).tone(Tone::Tertiary).truncate()),
    );
    let button = Clickable::new((id.clone(), "source"))
        .variant(ClickVariant::Text)
        .stretch()
        .on_click(move |event, window, cx| on_open(event, window, cx))
        .child(label);
    tracked(
        own_target(div().flex().flex_1().min_w_0())
            .id((id.clone(), "source-part"))
            .child(button),
        parts,
        SOURCE,
    )
    .into_any_element()
}
