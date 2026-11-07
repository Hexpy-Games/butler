//! Answer blocks: timeline, checklist, progress, text, image, quote, facts, metrics, callout, actions
//! (`AnswerLeafBlocks.tsx` and the facts, metrics, callout and actions branches of `AnswerBlocks.tsx`).
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::event_timeline::{EventTimeline, EventTimelineItem};
use butler_ds::ui::blocks::key_value_row::KeyValueRow;
use butler_ds::ui::blocks::markdown_content::{Density, MarkdownContent};
use butler_ds::ui::blocks::metric_card::{MetricCard, Trend};
use butler_ds::ui::blocks::notice::{Notice, NoticeTone};
use butler_ds::ui::blocks::progress_meter::ProgressMeter;
use butler_ds::ui::blocks::status_checklist::{ChecklistItem, StatusChecklist};
use butler_ds::ui::button::{Button, Variant as ButtonVariant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::layout::{Columns, Grid, Inline, Space, Stack};
use butler_ds::ui::media_frame::{Aspect, MediaFrame};
use butler_ds::ui::pill_button::{PillButton, Surface};
use butler_ds::ui::typo::{Tone, Typo, Weight};
use gpui::{
    AnyElement, App, ElementId, InteractiveElement as _, IntoElement as _, ParentElement as _,
    ImageSource, SharedString, StatefulInteractiveElement as _, Styled as _, div,
};

use super::frame::source_line;
use crate::ui::shell::image_viewer::loader::{PictureId, picture};
use crate::ui::shell::image_viewer::{self, ViewerEntry};
use crate::ui::source::wire::{
    AnswerBlock, AnswerBlockActionsItemsItem, AnswerBlockCalloutTone, AnswerBlockMetricsItemsItem,
    AnswerBlockMetricsItemsItemDirection, AnswerBlockMetricsItemsItemValue,
};

/// Renders one block of this family (timeline, checklist, progress, text, image, quote, facts,
/// metrics, callout, actions).
pub(super) fn render(block: &AnswerBlock, path: &str, cx: &mut App) -> AnyElement {
    match block {
        AnswerBlock::Timeline { items, .. } => timeline(&base(path, "timeline"), items, cx),
        AnswerBlock::Checklist { items, .. } => StatusChecklist::new(
            items
                .iter()
                .map(|item| ChecklistItem::new(item.text.clone(), item.done)),
        )
        .into_any_element(),
        AnswerBlock::Progress { items, .. } => progress(&base(path, "progress"), items, cx),
        AnswerBlock::Text { text, .. } => MarkdownContent::new(base(path, "text"), text.clone())
            .density(Density::Compact)
            .into_any_element(),
        AnswerBlock::Quote {
            text,
            cite,
            source,
            ..
        } => quote(
            &base(path, "quote"),
            text,
            cite.as_deref(),
            source.as_deref(),
            cx,
        ),
        AnswerBlock::Image {
            img,
            caption,
            source,
            ..
        } => image(
            &base(path, "image"),
            img,
            caption.as_deref(),
            source.as_deref(),
            cx,
        ),
        AnswerBlock::Facts { items, .. } => facts(&base(path, "facts"), items, cx),
        AnswerBlock::Metrics { items, .. } => metrics(&base(path, "metrics"), items, cx),
        AnswerBlock::Callout { tone, text, .. } => {
            Notice::new(callout_tone(tone.as_ref()), text.clone()).into_any_element()
        }
        AnswerBlock::Actions { items, .. } => actions(&base(path, "actions"), items, cx),
        _ => div().into_any_element(),
    }
}

/// The block's element id: its type and its path.
fn base(path: &str, kind: &str) -> SharedString {
    format!("answer-{kind}-{path}").into()
}

fn child_id(base: &SharedString, part: &str, index: usize) -> ElementId {
    ElementId::Name(format!("{base}-{part}-{index}").into())
}

fn timeline(
    base: &SharedString,
    items: &[crate::ui::source::wire::AnswerBlockTimelineItemsItem],
    cx: &mut App,
) -> AnyElement {
    let mut events = EventTimeline::new();
    for (index, item) in items.iter().enumerate() {
        let marker = icon(Icon::Circle, IconSize::Sm, Ds::get(cx));
        let mut text = Stack::new()
            .gap(Space::Xs)
            .child(Typo::caption(item.when.clone()).tone(Tone::Tertiary))
            .child(Typo::label(item.title.clone()).weight(Weight::Semibold));
        if let Some(body) = &item.text {
            text = text.child(Typo::body(body.clone()));
        }
        text = text.children(source_line(
            child_id(base, "source", index),
            item.source.as_deref(),
            item.checked.as_deref(),
        ));
        events = events.item(EventTimelineItem::new(marker, text));
    }
    events.into_any_element()
}

fn progress(
    base: &SharedString,
    items: &[crate::ui::source::wire::AnswerBlockProgressItemsItem],
    _cx: &mut App,
) -> AnyElement {
    let mut rows = Stack::new().gap(Space::Sm);
    for (index, item) in items.iter().enumerate() {
        let max = item.max.unwrap_or(100.);
        let unit = item
            .unit
            .as_deref()
            .map_or(String::new(), |u| format!(" {u}"));
        let meter = ProgressMeter::new(
            child_id(base, "meter", index),
            (item.value / max * 100.) as f32,
        )
        .label(item.label.clone())
        .meta(format!("{} / {max}{unit}", item.value));
        rows = rows.child(
            Stack::new()
                .gap(Space::Xs)
                .child(meter)
                .children(source_line(
                    child_id(base, "source", index),
                    item.source.as_deref(),
                    item.checked.as_deref(),
                )),
        );
    }
    rows.into_any_element()
}

fn quote(
    base: &SharedString,
    text: &str,
    cite: Option<&str>,
    source: Option<&str>,
    _cx: &mut App,
) -> AnyElement {
    let full = match cite {
        Some(cite) if !cite.is_empty() => format!("{text} — {cite}"),
        _ => text.to_string(),
    };
    let quoted: Vec<String> = full.lines().map(|line| format!("> {line}")).collect();
    Stack::new()
        .gap(Space::Xs)
        .child(MarkdownContent::new(base.clone(), quoted.join("\n")).density(Density::Compact))
        .children(source_line(child_id(base, "source", 0), source, None))
        .into_any_element()
}

/// `AnswerImage`: the collected picture over its caption; a click opens the viewer.
fn image(
    base: &SharedString,
    img: &str,
    caption: Option<&str>,
    source: Option<&str>,
    cx: &mut App,
) -> AnyElement {
    let asset = PictureId::Asset(img.to_owned());
    let mut media = MediaFrame::new(ElementId::Name(format!("{base}-frame").into()))
        .aspect(Aspect::Square)
        .placeholder();
    if let Some(loaded) = picture(&asset, cx) {
        media = media.src(ImageSource::Image(loaded));
    }
    let mut entry = ViewerEntry::new(asset, caption.unwrap_or_default().to_owned());
    entry.caption = caption.map(str::to_owned);
    entry.source = source.map(str::to_owned);
    let opened = div()
        .id(ElementId::Name(format!("{base}-open").into()))
        .cursor_pointer()
        .on_click(move |_, _, cx| image_viewer::open(vec![entry.clone()], 0, cx))
        .child(media);
    let mut frame = Stack::new().gap(Space::Xs).child(opened);
    if let Some(caption) = caption.filter(|caption| !caption.is_empty()) {
        frame = frame.child(Typo::caption(caption.to_string()));
    }
    frame
        .children(source_line(child_id(base, "source", 0), source, None))
        .into_any_element()
}

fn facts(
    base: &SharedString,
    items: &[crate::ui::source::wire::AnswerBlockFactsItemsItem],
    _cx: &mut App,
) -> AnyElement {
    let mut rows = Stack::new().gap(Space::Xs);
    for (index, item) in items.iter().enumerate() {
        rows = rows.child(
            Stack::new()
                .gap(Space::None)
                .child(KeyValueRow::new(item.label.clone(), item.value.clone()))
                .children(source_line(
                    child_id(base, "source", index),
                    item.source.as_deref(),
                    item.checked.as_deref(),
                )),
        );
    }
    rows.into_any_element()
}

fn metrics(
    base: &SharedString,
    items: &[AnswerBlockMetricsItemsItem],
    _cx: &mut App,
) -> AnyElement {
    let mut grid = Grid::new(ElementId::Name(format!("{base}-grid").into()))
        .gap(Space::Md)
        .columns(Columns::auto_fill_min(150));
    for (index, item) in items.iter().enumerate() {
        let value = match &item.value {
            AnswerBlockMetricsItemsItemValue::Variant1(text) => text.clone(),
            AnswerBlockMetricsItemsItemValue::Variant2(number) => number.to_string(),
        };
        let value = [Some(value), item.unit.clone()]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(" ");
        let mut card = MetricCard::text(child_id(base, "card", index), value, item.label.clone())
            .trend(metric_trend(item.delta.as_deref(), item.direction.as_ref()));
        if let Some(delta) = &item.delta {
            card = card.change(delta.clone());
        }
        grid = grid.child(
            Stack::new()
                .gap(Space::Xs)
                .child(card)
                .children(source_line(
                    child_id(base, "source", index),
                    item.source.as_deref(),
                    item.checked.as_deref(),
                )),
        );
    }
    grid.into_any_element()
}

/// `answerMetricTrend`: the delta's sign against whether up or down is the good direction.
fn metric_trend(
    delta: Option<&str>,
    direction: Option<&AnswerBlockMetricsItemsItemDirection>,
) -> Trend {
    let sign = match delta {
        Some(delta) if delta.starts_with('+') => 1,
        Some(delta) if delta.starts_with('-') => -1,
        _ => 0,
    };
    let up_good = match direction {
        None | Some(AnswerBlockMetricsItemsItemDirection::UpGood) => true,
        Some(AnswerBlockMetricsItemsItemDirection::DownGood) => false,
        Some(_) => return Trend::Neutral,
    };
    if sign == 0 {
        Trend::Neutral
    } else if (sign > 0) == up_good {
        Trend::Up
    } else {
        Trend::Down
    }
}

fn callout_tone(tone: Option<&AnswerBlockCalloutTone>) -> NoticeTone {
    match tone {
        Some(AnswerBlockCalloutTone::Info) => NoticeTone::Info,
        Some(AnswerBlockCalloutTone::Success) => NoticeTone::Success,
        Some(AnswerBlockCalloutTone::Warning) => NoticeTone::Warning,
        _ => NoticeTone::Neutral,
    }
}

fn actions(base: &SharedString, items: &[AnswerBlockActionsItemsItem], cx: &mut App) -> AnyElement {
    let mut row = Inline::new();
    for (index, item) in items.iter().enumerate() {
        let id = child_id(base, "action", index);
        row = match item {
            AnswerBlockActionsItemsItem::Variant1(ask) => row.child(
                PillButton::new(id)
                    .surface(Surface::Glass)
                    .icon(icon(Icon::Reply, IconSize::Sm, Ds::get(cx)))
                    .text(ask.ask.clone()),
            ),
            AnswerBlockActionsItemsItem::Variant2(open) => {
                let url = open.open.clone();
                row.child(
                    Button::new(id)
                        .variant(ButtonVariant::Secondary)
                        .icon_start(icon(Icon::Popup, IconSize::Sm, Ds::get(cx)))
                        .text(open.label.clone())
                        .on_click(move |_, _, cx| cx.open_url(&url)),
                )
            }
        };
    }
    row.into_any_element()
}
