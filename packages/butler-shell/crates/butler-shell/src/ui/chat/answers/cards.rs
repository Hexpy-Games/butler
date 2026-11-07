//! Answer blocks: cards (`AnswerCards.tsx`, `useAnswerCardGrid.ts`, `answerValueFormat.ts`).
mod bridge;
mod value;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::SystemTime;

use butler_ds::ui::Icon;
use butler_ds::ui::blocks::item_card::{ItemCard, ItemSource, ItemValue};
use butler_ds::ui::blocks::measure;
use butler_ds::ui::button::{Button, Variant};
use butler_ds::ui::collapsible::Collapsible;
use butler_ds::ui::context::{Ds, Lang};
use butler_ds::ui::copy_button::CopyButton;
use butler_ds::ui::done_icon_button::DoneIconButton;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::layout::{Columns, Grid, Space, Stack};
use butler_ds::ui::media_frame::{Aspect, Fit, MediaFrame};
use butler_ds::ui::toast::{self, Toast};
use gpui::{
    AnyElement, App, ElementId, ImageSource, IntoElement, ParentElement as _, RenderOnce,
    SharedString, Styled as _, Window, div,
};
use serde_json::{Map, Value, json};

use crate::ui::i18n::media::Media;
use crate::ui::shell::image_viewer::loader::{PictureId, picture};
use crate::ui::shell::image_viewer::source::site_of;
use crate::ui::shell::image_viewer::{self, ViewerEntry};
use crate::ui::source::wire::{AnswerBlock, AnswerMedia, CardItem};

/// Cards shown before "Show N more".
const COLLAPSED: usize = 6;
/// `cardColumns`: the narrowest card column, and the width below which cards stack.
const MIN_CARD: f32 = 168.;
const STACK_BELOW: f32 = 560.;

/// Renders one block of this family (cards). Epics have no DS pieces yet and show nothing.
pub(super) fn render(block: &AnswerBlock, path: &str) -> AnyElement {
    match block {
        AnswerBlock::Cards { media, items, .. } => AnswerCards {
            id: ElementId::Name(format!("answer-cards-{path}").into()),
            media: aspect(media.as_ref()),
            items: items.clone(),
            viewer: viewer_entries(items),
        }
        .into_any_element(),
        _ => div().into_any_element(),
    }
}

/// `answerImages`: the pictures of the items that have one, in item order, for the viewer.
fn viewer_entries(items: &[CardItem]) -> Vec<ViewerEntry> {
    items
        .iter()
        .filter_map(|item| {
            let mut entry =
                ViewerEntry::new(PictureId::Asset(item.img.clone()?), item.title.clone());
            entry.caption = Some(item.title.clone());
            entry.source = item.source.clone();
            entry.checked = item.checked.clone();
            Some(entry)
        })
        .collect()
}

/// `media ?? "1:1"`.
fn aspect(media: Option<&AnswerMedia>) -> Aspect {
    match media {
        Some(AnswerMedia::V45) => Aspect::FourFive,
        Some(AnswerMedia::V34) => Aspect::ThreeFour,
        Some(AnswerMedia::V169) => Aspect::SixteenNine,
        Some(AnswerMedia::V11 | AnswerMedia::Unknown) | None => Aspect::Square,
    }
}

/// `useAnswerCardGrid`'s `cardColumns` for a list that is not streaming.
fn card_columns(width: f32, gap: f32, count: usize) -> u8 {
    let mut columns = if width < STACK_BELOW {
        1
    } else {
        let limit = u8::try_from(count).unwrap_or(4).min(4);
        (1..=limit)
            .filter(|n| f32::from(*n) * (MIN_CARD + gap) <= width + gap)
            .max()
            .unwrap_or(1)
    };
    while columns > 1 && count % usize::from(columns) == 1 {
        columns -= 1;
    }
    columns.max(1)
}

/// `answerCardCopy`.
fn card_copy(item: &CardItem, lang: Lang) -> String {
    [
        Some(item.title.clone()),
        item.value
            .as_ref()
            .map(|v| value::format_value(v, lang, value::amount(v))),
        item.source.clone(),
    ]
    .into_iter()
    .flatten()
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>()
    .join(" · ")
}

/// The scrap `saveAnswerItem` posts: the card's structured fields and its text.
fn scrap(item: &CardItem, lang: Lang) -> Value {
    let now = SystemTime::now();
    let nanos = now
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let formatted = item
        .value
        .as_ref()
        .map(|v| value::format_value(v, lang, value::amount(v)));
    let text = formatted
        .into_iter()
        .chain(item.facts.iter().flatten().cloned())
        .chain(item.text.clone())
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" · ");
    let fields: Map<String, Value> = [
        ("title", Some(json!(item.title))),
        ("sub", item.sub.as_ref().map(|v| json!(v))),
        ("label", item.label.as_ref().map(|v| json!(v))),
        ("value", item.value.as_ref().map(value::to_json)),
        ("facts", item.facts.as_ref().map(|v| json!(v))),
        ("text", item.text.as_ref().map(|v| json!(v))),
        ("source", item.source.as_ref().map(|v| json!(v))),
        ("checked", item.checked.as_ref().map(|v| json!(v))),
    ]
    .into_iter()
    .filter_map(|(key, field)| Some((key.to_owned(), field?)))
    .collect();
    let mut body = json!({
        "id": format!("scrap-{nanos:x}"),
        "kind": "scrap",
        "title": item.title,
        "url": item.source.clone().unwrap_or_default(),
        "fields": fields,
        "capturedAt": chrono::DateTime::<chrono::Utc>::from(now).to_rfc3339(),
        "text": text,
    });
    if let (Some(site), Some(map)) = (
        item.source.as_deref().and_then(site_of),
        body.as_object_mut(),
    ) {
        map.insert("site".to_owned(), json!(site));
    }
    body
}

#[derive(IntoElement)]
struct AnswerCards {
    id: ElementId,
    media: Aspect,
    items: Vec<CardItem>,
    /// The viewer's set: the pictures of the items that have one.
    viewer: Vec<ViewerEntry>,
}

impl AnswerCards {
    /// Starts the fetch of every picture not asked for yet and returns those that have arrived.
    fn pictures(&self, cx: &mut App) -> HashMap<String, Arc<gpui::Image>> {
        let mut loaded = HashMap::new();
        for asset in self.items.iter().filter_map(|item| item.img.as_ref()) {
            if let Some(image) = picture(&PictureId::Asset(asset.clone()), cx) {
                loaded.insert(asset.clone(), image);
            }
        }
        loaded
    }

    /// `AnswerCard`: one item on an ItemCard.
    fn card(
        &self,
        index: usize,
        picture: Option<ImageSource>,
        lang: Lang,
        cx: &App,
    ) -> Option<ItemCard> {
        let item = self.items.get(index)?;
        let copy = Media::of(lang);
        let id: ElementId = (
            self.id.clone(),
            item.key.clone().unwrap_or_else(|| index.to_string()),
        )
            .into();
        let mut media = MediaFrame::new((id.clone(), "media"))
            .aspect(self.media)
            .fit(Fit::Cover)
            .placeholder();
        let opens = picture.is_some();
        if let Some(picture) = picture {
            media = media.src(picture);
        }
        let mut card = ItemCard::new(id.clone(), item.title.clone())
            .media(media)
            .toggle_labels(copy.answer_show_more, copy.show_less);
        if let Some(label) = &item.label {
            card = card.eyebrow(label.clone());
        }
        if let Some(sub) = &item.sub {
            card = card.subtitle(sub.clone());
        }
        if let Some(text) = &item.text {
            card = card.text(text.clone());
        }
        if let Some(facts) = &item.facts {
            card = card.facts(facts.clone());
        }
        if let Some(v) = &item.value {
            let amount = value::format_value(v, lang, value::amount(v));
            let mut shown = ItemValue::new(amount);
            if let Some(was) = value::was(v) {
                shown = shown.was(value::format_value(v, lang, was));
            }
            if let Some(note) = value::note(v) {
                shown = shown.note(note.to_owned());
            }
            card = card.value(shown);
        }
        if let Some(url) = &item.source
            && let Some(site) = site_of(url)
        {
            let open = url.clone();
            card = card
                .source(ItemSource::new(site, {
                    let open = open.clone();
                    move |_, _, cx| cx.open_url(&open)
                }))
                .on_open(move |_, _, cx| cx.open_url(&open));
        }
        if opens && let Some(at) = self.viewer_index(index) {
            let entries = self.viewer.clone();
            card = card.on_media_open(move |_, _, cx| image_viewer::open(entries.clone(), at, cx));
        }
        Some(
            card.action(self.save_action(&id, item, lang, cx)).action(
                CopyButton::new((id, "copy"), copy.copy, copy.answer_copied)
                    .text(card_copy(item, lang)),
            ),
        )
    }

    /// The place of item `index` among the viewer's pictures.
    fn viewer_index(&self, index: usize) -> Option<usize> {
        self.items.get(index)?.img.as_ref()?;
        Some(
            self.items[..index]
                .iter()
                .filter(|item| item.img.is_some())
                .count(),
        )
    }

    /// The footer's "save to library" button.
    fn save_action(&self, id: &ElementId, item: &CardItem, lang: Lang, cx: &App) -> DoneIconButton {
        let copy = Media::of(lang);
        let item = item.clone();
        DoneIconButton::new(
            (id.clone(), "save"),
            copy.save_to_library,
            copy.saved_to_library,
        )
        .icon(icon(Icon::Library, IconSize::Sm, Ds::get(cx)))
        .on_action(move |window, cx| {
            bridge::save(scrap(&item, lang), copy.action_failed.into(), window, cx)
        })
        .on_error(|message: &SharedString, cx| {
            toast::show(cx, Toast::error(message.clone()));
        })
    }

    /// `Grid` of the first `count` cards.
    fn grid(
        &self,
        id: &'static str,
        count: usize,
        columns: u8,
        pictures: &HashMap<String, Arc<gpui::Image>>,
        (lang, gap): (Lang, Space),
        cx: &App,
    ) -> Grid {
        let cards = (0..count).filter_map(|index| {
            let picture = self.items[index]
                .img
                .as_ref()
                .and_then(|asset| pictures.get(asset))
                .map(|image| ImageSource::from(image.clone()));
            self.card(index, picture, lang, cx)
        });
        Grid::new((self.id.clone(), id))
            .columns(Columns::fixed(columns))
            .gap(gap)
            .fill_cells()
            .children(cards)
    }
}

impl RenderOnce for AnswerCards {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let lang = Ds::get(cx).lang();
        let expanded = window.use_keyed_state((self.id.clone(), "expanded"), cx, |_, _| false);
        let open = *expanded.read(cx);
        let pictures = self.pictures(cx);
        let (size, recorder) = measure::track((self.id.clone(), "width"), window, cx);
        let gap = f32::from(Space::Sm.px(Ds::get(cx)));
        let total = self.items.len();
        let shown = if open { total } else { total.min(COLLAPSED) };
        let columns = card_columns(f32::from(size.width), gap, shown);
        let spec = (lang, Space::Sm);
        let mut stack = Stack::new().gap(Space::Sm);
        if !open {
            stack = stack.child(self.grid("collapsed", shown, columns, &pictures, spec, cx));
        }
        stack = stack.child(
            Collapsible::new((self.id.clone(), "all"), open)
                .child(self.grid("all", total, columns, &pictures, spec, cx)),
        );
        if total > COLLAPSED {
            let label = if open {
                Media::of(lang).show_less.to_owned()
            } else {
                Media::show_more_items(lang, total - COLLAPSED)
            };
            stack = stack.child(
                Button::new((self.id.clone(), "toggle"))
                    .variant(Variant::Inline)
                    .text(label)
                    .on_click(move |_, _, cx| {
                        expanded.update(cx, |open, cx| {
                            *open = !*open;
                            cx.notify();
                        });
                    }),
            );
        }
        div().relative().child(recorder).child(stack)
    }
}
