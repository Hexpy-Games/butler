//! ItemCard.showcase.tsx and ItemCard.demo.tsx: answer grids of unrelated items at every
//! orientation, the card states, the skeletons that hold the next slots, and the stream that
//! settles once when the list closes.
mod fixtures;
mod stream;

use butler_ds::ui::Icon;
use butler_ds::ui::blocks::item_card::{ItemCard, ItemCardSkeleton, ItemSource, ItemValue};
use butler_ds::ui::context::Ds;
use butler_ds::ui::copy_button::CopyButton;
use butler_ds::ui::done_icon_button::DoneIconButton;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::layout::{Columns, Grid, GridCross, Preset, Responsive, Space};
use butler_ds::ui::media_frame::{Aspect, MediaFrame};
use gpui::{AnyElement, App, ImageSource, IntoElement as _, Window};

use self::fixtures::{Item, items, labels};
use super::Story;
use super::done_icon_button::save;
use super::media_frame::fixtures::{broken, picture_of};
use crate::copy::Lang;

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Answer grid: five unrelated items",
            render: |lang, _, cx| {
                grid(
                    "ic-answer",
                    columns(3, 1),
                    Space::Md,
                    cards(lang, 5, "ic-answer", cx),
                )
            },
        },
        Story {
            name: "Four across: vertical cards below 340px",
            render: |lang, _, cx| {
                grid(
                    "ic-four",
                    columns(4, 1),
                    Space::Md,
                    cards(lang, 4, "ic-four", cx),
                )
            },
        },
        Story {
            name: "Two across: rows from 340px",
            render: |lang, _, cx| {
                grid(
                    "ic-two",
                    columns(2, 1),
                    Space::Md,
                    cards(lang, 4, "ic-two", cx),
                )
            },
        },
        Story {
            name: "Phone: one column of rows",
            render: |lang, _, cx| {
                grid(
                    "ic-phone",
                    Columns::fixed(1),
                    Space::Md,
                    cards(lang, 5, "ic-phone", cx),
                )
            },
        },
        Story {
            name: "States: no picture, failed picture, minimal, no footer, long text",
            render: states,
        },
        Story {
            name: "Loading: skeletons hold the next slots",
            render: loading,
        },
        Story {
            name: "Loading: the skeleton is the box of the card it becomes",
            render: |lang, _, cx| stream::skeleton_pair(lang, Some(Aspect::Square), cx),
        },
        Story {
            name: "Loading: without a picture",
            render: |lang, _, cx| stream::skeleton_pair(lang, None, cx),
        },
        Story {
            name: "Settle: cards stream in, the grid settles once at close",
            render: |lang, window, cx| stream::settle(lang, false, window, cx),
        },
        Story {
            name: "Reduced motion: fades only, a static skeleton, the height at once",
            render: |lang, window, cx| stream::settle(lang, true, window, cx),
        },
    ]
}

/// `{ base, compact }` columns of the answer grids.
pub(super) fn columns(base: u8, compact: u8) -> Columns {
    Columns::Responsive(Responsive {
        compact: Some(compact),
        base: Preset::Fixed(base),
        wide: None,
    })
}

fn grid(id: &'static str, columns: Columns, gap: Space, cards: Vec<ItemCard>) -> AnyElement {
    Grid::new(id)
        .columns(columns)
        .gap(gap)
        .fill_cells()
        .children(cards)
        .into_any_element()
}

/// What a card shows, so one mapping builds the full card and the states that drop parts.
#[expect(
    clippy::struct_excessive_bools,
    reason = "independent parts of the card, as ItemCard's optional props"
)]
#[derive(Clone, Copy)]
struct Show {
    media: bool,
    header: bool,
    value: bool,
    facts: bool,
    text: bool,
    footer: bool,
    open: bool,
}

impl Show {
    const ALL: Self = Self {
        media: true,
        header: true,
        value: true,
        facts: true,
        text: true,
        footer: true,
        open: true,
    };
}

/// The container's mapping: a found item to ItemCard props.
fn build(
    id: &str,
    lang: Lang,
    item: &Item,
    (picture, text): (Option<ImageSource>, &str),
    show: Show,
    cx: &App,
) -> ItemCard {
    let l = labels(lang);
    let mut card = ItemCard::new(id.to_owned(), item.title);
    if show.header {
        card = card.eyebrow(item.eyebrow).subtitle(item.subtitle);
    }
    if show.media {
        let frame = MediaFrame::new(format!("{id}-media")).aspect(Aspect::FourFive);
        card = card
            .media(match picture {
                Some(src) => frame.src(src),
                None => frame,
            })
            .on_media_open(|_, _, _| {});
    }
    if show.value {
        let mut value = ItemValue::new(item.amount).note(item.note);
        if let Some(was) = item.was {
            value = value.was(was);
        }
        card = card.value(value);
    }
    if show.facts {
        card = card.facts(item.facts.iter().copied());
    }
    if show.text {
        card = card.text(text.to_owned()).toggle_labels(l.more, l.less);
    }
    if show.footer {
        card = card
            .source(ItemSource::new(item.site, |_, _, _| {}).checked(l.checked))
            .action(
                DoneIconButton::new(format!("{id}-save"), l.save, l.saved)
                    .icon(icon(Icon::Scrap, IconSize::Sm, Ds::get(cx)))
                    .on_action(save(false)),
            )
            .action(
                CopyButton::new(format!("{id}-copy"), l.copy, l.copied)
                    .text(format!("{} · {}", item.title, item.amount)),
            );
    }
    if show.open {
        card = card.on_open(|_, _, _| {});
    }
    card
}

fn cards(lang: Lang, count: usize, story: &str, cx: &App) -> Vec<ItemCard> {
    items(lang)
        .iter()
        .take(count)
        .enumerate()
        .map(|(index, item)| {
            build(
                &format!("{story}-{index}"),
                lang,
                item,
                (Some(picture_of(item.picture)), item.text),
                Show::ALL,
                cx,
            )
        })
        .collect()
}

fn states(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let [paper, place, recipe, product, library] = items(lang);
    let all = Show::ALL;
    let plain = |id: &str, item: &Item, show: Show| {
        let parts = (Some(picture_of(item.picture)), item.text);
        build(id, lang, item, parts, show, cx)
    };
    let minimal = Show {
        media: false,
        header: false,
        value: true,
        facts: false,
        text: false,
        footer: false,
        open: false,
    };
    let long_text = format!("{0} {0} {0}", recipe.text);
    let bare = Show {
        header: false,
        value: false,
        facts: false,
        text: false,
        ..all
    };
    grid(
        "ic-states",
        columns(3, 1),
        Space::Md,
        vec![
            plain(
                "ic-st-0",
                &paper,
                Show {
                    media: false,
                    ..all
                },
            ),
            build(
                "ic-st-1",
                lang,
                &product,
                (Some(broken()), product.text),
                all,
                cx,
            ),
            plain("ic-st-2", &place, minimal),
            plain(
                "ic-st-3",
                &library,
                Show {
                    footer: false,
                    open: false,
                    ..all
                },
            ),
            build(
                "ic-st-4",
                lang,
                &recipe,
                (Some(picture_of(recipe.picture)), &long_text),
                all,
                cx,
            ),
            plain("ic-st-5", &paper, bare),
        ],
    )
}

fn loading(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    Grid::new("ic-loading")
        .columns(columns(4, 1))
        .gap(Space::Sm)
        .cross(GridCross::Start)
        .children(cards(lang, 2, "ic-load", cx))
        .child(ItemCardSkeleton::new("ic-skeleton-0").media(Some(Aspect::FourFive)))
        .child(ItemCardSkeleton::new("ic-skeleton-1").media(Some(Aspect::FourFive)))
        .into_any_element()
}
