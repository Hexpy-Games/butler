//! Answer blocks: cards (`AnswerCards.tsx`, `useAnswerCardGrid.ts`, `answerValueFormat.ts`).
mod bridge;
mod value;

use std::collections::{HashMap, HashSet};
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
use butler_shell_client::ShellClient;
use gpui::{
    AnyElement, App, ElementId, ImageSource, IntoElement, ParentElement as _, RenderOnce,
    SharedString, Styled as _, Window, div,
};
use serde_json::{Map, Value, json};

use crate::ui::chat::TranscriptCtx;
use crate::ui::source::wire::{AnswerBlock, AnswerMedia, CardItem};

/// Cards shown before "Show N more".
const COLLAPSED: usize = 6;
/// `cardColumns`: the narrowest card column, and the width below which cards stack.
const MIN_CARD: f32 = 168.;
const STACK_BELOW: f32 = 560.;

/// Renders one block of this family (cards, epics).
#[allow(
    dead_code,
    reason = "P2 shell-wave skeleton: wired by Opus at wave integration"
)]
pub(super) fn render(
    block: &AnswerBlock,
    t: &TranscriptCtx,
    _window: &mut Window,
    _cx: &mut App,
) -> AnyElement {
    match block {
        AnswerBlock::Cards { media, items, .. } => AnswerCards {
            id: ("answer-cards", std::ptr::from_ref(block).addr()).into(),
            media: aspect(media.as_ref()),
            items: items.clone(),
            client: t.client.clone(),
        }
        .into_any_element(),
        _ => div().into_any_element(),
    }
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

/// `appCopy.conversation.answerBlocks`.
struct Words {
    show_more: &'static str,
    show_less: &'static str,
    save: &'static str,
    saved: &'static str,
    copy: &'static str,
    copied: &'static str,
    failed: &'static str,
}

fn words(lang: Lang) -> Words {
    match lang {
        Lang::En => Words {
            show_more: "Show more",
            show_less: "Show less",
            save: "Save to library",
            saved: "Saved to library",
            copy: "Copy",
            copied: "Copied",
            failed: "Action failed",
        },
        Lang::Ko => Words {
            show_more: "더 보기",
            show_less: "접기",
            save: "서랍에 저장",
            saved: "서랍에 저장했어요",
            copy: "복사",
            copied: "복사했어요",
            failed: "실행하지 못했어요",
        },
    }
}

/// `showMoreItems(count)`.
fn more_items(lang: Lang, count: usize) -> String {
    match lang {
        Lang::En => format!("Show {count} more"),
        Lang::Ko => format!("{count}개 더 보기"),
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

/// The host of a source URL without `www.`.
fn site_of(url: &str) -> Option<String> {
    let url = url::Url::parse(url).ok()?;
    Some(url.host_str()?.trim_start_matches("www.").to_owned())
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

/// The pictures fetched so far, by asset id.
#[derive(Default)]
struct Pictures {
    requested: HashSet<String>,
    images: HashMap<String, Arc<gpui::Image>>,
}

#[derive(IntoElement)]
struct AnswerCards {
    id: ElementId,
    media: Aspect,
    items: Vec<CardItem>,
    client: Option<ShellClient>,
}

impl AnswerCards {
    /// Starts the fetch of every picture not asked for yet and returns those that have arrived.
    fn pictures(&self, window: &mut Window, cx: &mut App) -> HashMap<String, Arc<gpui::Image>> {
        let state = window.use_keyed_state((self.id.clone(), "pictures"), cx, |_, _| {
            Pictures::default()
        });
        if let Some(client) = &self.client {
            for asset in self.items.iter().filter_map(|item| item.img.as_ref()) {
                if !state.update(cx, |s, _| s.requested.insert(asset.clone())) {
                    continue;
                }
                let receive = bridge::picture(client.clone(), asset.clone());
                let (state, asset) = (state.clone(), asset.clone());
                window
                    .spawn(cx, async move |cx| {
                        if let Ok(Ok(image)) = receive.await {
                            let _ = cx.update(|_, cx| {
                                state.update(cx, |s, cx| {
                                    s.images.insert(asset, image);
                                    cx.notify();
                                });
                            });
                        }
                    })
                    .detach();
            }
        }
        state.read(cx).images.clone()
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
        let copy = words(lang);
        let id: ElementId = (
            self.id.clone(),
            item.key.clone().unwrap_or_else(|| index.to_string()),
        )
            .into();
        let mut media = MediaFrame::new((id.clone(), "media"))
            .aspect(self.media)
            .fit(Fit::Cover)
            .placeholder();
        if let Some(picture) = picture {
            media = media.src(picture);
        }
        let mut card = ItemCard::new(id.clone(), item.title.clone())
            .media(media)
            .toggle_labels(copy.show_more, copy.show_less);
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
        Some(card.action(self.save_action(&id, item, lang, cx)).action(
            CopyButton::new((id, "copy"), copy.copy, copy.copied).text(card_copy(item, lang)),
        ))
    }

    /// The footer's "save to library" button.
    fn save_action(&self, id: &ElementId, item: &CardItem, lang: Lang, cx: &App) -> DoneIconButton {
        let copy = words(lang);
        let (client, item) = (self.client.clone(), item.clone());
        DoneIconButton::new((id.clone(), "save"), copy.save, copy.saved)
            .icon(icon(Icon::Library, IconSize::Sm, Ds::get(cx)))
            .on_action(move |window, cx| {
                bridge::save(
                    client.clone(),
                    scrap(&item, lang),
                    copy.failed.into(),
                    window,
                    cx,
                )
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
        let pictures = self.pictures(window, cx);
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
                words(lang).show_less.to_owned()
            } else {
                more_items(lang, total - COLLAPSED)
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
