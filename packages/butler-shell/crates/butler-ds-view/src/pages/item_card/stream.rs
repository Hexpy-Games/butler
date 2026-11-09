//! ItemCard.demo.tsx: skeletons beside the cards they become, and five cards that arrive one by
//! one into width-driven columns, then settle once when the list closes (the lone-card rule
//! gives 3 + 2 instead of 4 + 1). The close applies the final columns and the shared row height
//! at once: the grid's brief dip and the height easing are not reproduced.

use butler_ds::ui::Icon;
use butler_ds::ui::blocks::item_card::{ItemCard, ItemCardSkeleton, ItemSource};
use butler_ds::ui::blocks::measure;
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::copy_button::CopyButton;
use butler_ds::ui::done_icon_button::DoneIconButton;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::layout::{Columns, Grid, GridCross, Inline, Space, Stack};
use butler_ds::ui::media_frame::{Aspect, Fit, MediaFrame};
use butler_ds::ui::motion;
use butler_ds::ui::presence::{Presence, PresenceMotion};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Styled as _, Window, div};

use super::fixtures::{Item, items, labels};
use crate::copy::Lang;
use crate::pages::done_icon_button::save;
use crate::pages::media_frame::fixtures::{Kind, favicon, picture_of};
use crate::pages::media_frame::late;

/// Cards arrive 700ms apart from 500ms; their pictures 450ms after the card.
const FIRST: u64 = 500; // DS: ItemCard.demo.tsx:100
const EVERY: u64 = 700; // DS: ItemCard.demo.tsx:100
const PICTURE_DELAY: u64 = 450; // DS: ItemCard.demo.tsx:23
/// One column below this width, else 168px cells, at most four (`useWidthColumns`).
const ONE_COLUMN_BELOW: f32 = 560.; // DS: ItemCard.demo.tsx:44
const CELL: f32 = 168.; // DS: ItemCard.demo.tsx:44

/// The actions every card of the demos carries: save to the library and copy.
fn actions(card: ItemCard, id: &str, text: String, lang: Lang, cx: &App) -> ItemCard {
    let l = labels(lang);
    card.action(
        DoneIconButton::new(format!("{id}-save"), l.save, l.saved)
            .icon(icon(Icon::Scrap, IconSize::Sm, Ds::get(cx)))
            .on_action(save(false)),
    )
    .action(CopyButton::new(format!("{id}-copy"), l.copy, l.copied).text(text))
}

/// A card with exactly a subtitle, a one-line title and one line of facts: the parts the
/// skeleton reserves.
fn pair_card(lang: Lang, media: Option<Aspect>, cx: &App) -> ItemCard {
    let l = labels(lang);
    let (subtitle, title, facts) = lang.pick(
        ("Trail", "Lakeside loop", ["4.6 km", "Flat"]),
        ("산책로", "호숫가 산책로", ["4.6km", "평지"]),
    );
    let site = "trails.example.org";
    let mut card = ItemCard::new("ic-pair-card", title)
        .subtitle(subtitle)
        .facts(facts)
        .source(ItemSource::new(site, |_, _, _| {}).checked(l.checked));
    if let Some(aspect) = media {
        card = card.media(
            MediaFrame::new("ic-pair-media")
                .aspect(aspect)
                .fit(Fit::Cover)
                .src(picture_of(Kind::Place)),
        );
    }
    actions(card, "ic-pair", title.to_owned(), lang, cx)
}

/// Skeletons beside the cards they become, vertical (four across) and as rows (two across).
pub(super) fn skeleton_pair(lang: Lang, media: Option<Aspect>, cx: &mut App) -> AnyElement {
    let across = |id: &'static str, count: u8| {
        Grid::new(id)
            .columns(Columns::fixed(count))
            .gap(Space::Sm)
            .cross(GridCross::Start)
            .child(ItemCardSkeleton::new(format!("{id}-skeleton")).media(media))
            .child(pair_card(lang, media, cx))
            .into_any_element()
    };
    Stack::new()
        .gap(Space::Md)
        .child(across("ic-pair-four", 4))
        .child(across("ic-pair-two", 2))
        .into_any_element()
}

/// One card of the stream: its picture arrives a moment after the card, as over a network.
fn stream_card(
    item: &Item,
    (lang, round, index): (Lang, usize, usize),
    reduced: bool,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let l = labels(lang);
    let id = format!("ic-stream-{round}-{index}");
    let src = late(window, cx, &id, PICTURE_DELAY, || picture_of(item.picture));
    let mut frame = MediaFrame::new(format!("{id}-media"))
        .aspect(Aspect::Square)
        .fit(Fit::Cover)
        .placeholder_icon(favicon());
    if src.is_some() {
        frame = frame.placeholder();
    }
    if let Some(src) = src {
        frame = frame.src(src);
    }
    if reduced {
        frame = frame.reduced_motion(true);
    }
    let mut card = ItemCard::new(id.clone(), item.title)
        .eyebrow(item.eyebrow)
        .subtitle(item.subtitle)
        .facts(item.facts.iter().copied())
        .media(frame)
        .source(ItemSource::new(item.site, |_, _, _| {}).checked(l.checked))
        .on_open(|_, _, _| {});
    let mut value = butler_ds::ui::blocks::item_card::ItemValue::new(item.amount).note(item.note);
    if let Some(was) = item.was {
        value = value.was(was);
    }
    card = actions(card.value(value), &id, item.title.to_owned(), lang, cx);
    Presence::new(format!("{id}-presence"), true)
        .motion(PresenceMotion::Rise)
        .child(card)
        .into_any_element()
}

/// The lone-card rule: no last row with a single card (5 cards: 3 + 2, not 4 + 1).
fn final_columns(columns: usize, count: usize) -> usize {
    let mut n = columns.min(count);
    while n > 1 && count % n == 1 {
        n -= 1;
    }
    n.max(1)
}

/// Columns from the grid's width alone while the list is open.
fn width_columns(width: f32, gap: f32) -> usize {
    if width < ONE_COLUMN_BELOW {
        return 1;
    }
    #[expect(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "a column count from a positive width"
    )]
    let fit = ((width + gap) / (CELL + gap)).floor() as usize;
    fit.clamp(1, 4)
}

/// How many cards have arrived `elapsed` into the stream, and whether the list has closed.
fn timeline(
    id: String,
    elapsed: std::time::Duration,
    total: usize,
    window: &mut Window,
    cx: &mut App,
) -> (usize, bool) {
    window.use_keyed_state(id, cx, |_, cx| {
        let count = total;
        cx.spawn(async move |this, cx| {
            let steps =
                [std::time::Duration::from_millis(FIRST)]
                    .into_iter()
                    .chain(std::iter::repeat_n(
                        std::time::Duration::from_millis(EVERY),
                        count,
                    ));
            for step in steps {
                motion::sleep(cx.background_executor(), step).await;
                if this.update(cx, |_, cx| cx.notify()).is_err() {
                    return;
                }
            }
        })
    });
    let ms = u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX);
    let count = total as u64;
    let arrived = if ms < FIRST {
        0
    } else {
        usize::try_from(((ms - FIRST) / EVERY + 1).min(count)).unwrap_or(total)
    };
    (arrived, ms >= FIRST + count * EVERY)
}

/// Five cards arrive one by one into width-driven columns; a skeleton holds the next slot and
/// cells keep their own height. At close the lone-card rule gives the final columns and rows
/// share their height.
pub(super) fn settle(lang: Lang, reduced: bool, window: &mut Window, cx: &mut App) -> AnyElement {
    let tag = if reduced { "reduced" } else { "live" };
    let round = window.use_keyed_state(format!("ic-settle-{tag}-round"), cx, |_, _| 0usize);
    let started = window.use_keyed_state(format!("ic-settle-{tag}-start"), cx, |_, cx| {
        cx.background_executor().now()
    });
    let current = *round.read(cx);
    let (restart, tag_owned) = (started.clone(), tag.to_owned());
    let items = items(lang);
    let elapsed = cx
        .background_executor()
        .now()
        .saturating_duration_since(*started.read(cx));
    let ticker = format!("ic-settle-{tag}-ticker-{current}");
    let (arrived, closed) = timeline(ticker, elapsed, items.len(), window, cx);
    let (measured, recorder) = measure::track(format!("ic-settle-{tag}-width"), window, cx);
    let live = width_columns(f32::from(measured.width), 8.);
    let across = if closed {
        final_columns(live, items.len())
    } else {
        live
    };
    let cards: Vec<AnyElement> = (0..arrived)
        .map(|index| stream_card(&items[index], (lang, current, index), reduced, window, cx))
        .collect();
    let mut grid = Grid::new(format!("ic-settle-{tag}"))
        .columns(Columns::fixed(u8::try_from(across).unwrap_or(1)))
        .gap(Space::Sm)
        .cross(if closed {
            GridCross::Stretch
        } else {
            GridCross::Start
        })
        .children(cards);
    if closed {
        grid = grid.fill_cells();
    } else {
        let loading = lang.pick("Loading answer cards", "답변 카드를 준비하는 중");
        let mut skeleton =
            ItemCardSkeleton::new(format!("ic-settle-{tag}-skeleton")).media(Some(Aspect::Square));
        if arrived == 0 {
            skeleton = skeleton.label(loading);
        }
        grid = grid.child(skeleton);
    }
    let replay = lang.pick("Replay", "다시 보기");
    Stack::new()
        .gap(Space::Md)
        .child(div().relative().child(recorder).child(grid))
        .child(
            Inline::new().child(
                Button::new(format!("ic-settle-{tag_owned}-replay"))
                    .variant(Variant::Secondary)
                    .size(Size::Sm)
                    .text(replay)
                    .on_click(move |_, _, cx| {
                        round.update(cx, |round, cx| {
                            *round += 1;
                            cx.notify();
                        });
                        restart.update(cx, |at, cx| {
                            *at = cx.background_executor().now();
                            cx.notify();
                        });
                    }),
            ),
        )
        .child(super::super::probe(format!(
            "ic-settle-{tag}-columns-{across}-closed-{closed}"
        )))
        .into_any_element()
}
