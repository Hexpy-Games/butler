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
use butler_ds::ui::clickable::{Clickable, Variant as ClickableVariant};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::layout::{Columns, Grid, Inline, Space, Stack};
use butler_ds::ui::media_frame::{Aspect, MediaFrame};
use butler_ds::ui::pill_button::{PillButton, Surface};
use butler_ds::ui::typo::{Tone, Typo, Weight};
use gpui::{
    AnyElement, App, ElementId, IntoElement as _, ParentElement as _, SharedString, Window, div,
};

use crate::ui::chat::TranscriptCtx;
use crate::ui::source::wire::{
    AnswerBlock, AnswerBlockActionsItemsItem, AnswerBlockCalloutTone, AnswerBlockMetricsItemsItem,
    AnswerBlockMetricsItemsItemDirection, AnswerBlockMetricsItemsItemValue,
};

/// Renders one block of this family (timeline, checklist, progress, text, image, quote, facts,
/// metrics, callout, actions).
#[allow(
    dead_code,
    reason = "P2 shell-wave skeleton: wired by Opus at wave integration"
)]
pub(super) fn render(
    block: &AnswerBlock,
    _t: &TranscriptCtx,
    _window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    match block {
        AnswerBlock::Timeline { id, items, .. } => timeline(&base(id, "timeline"), items, cx),
        AnswerBlock::Checklist { items, .. } => StatusChecklist::new(
            items
                .iter()
                .map(|item| ChecklistItem::new(item.text.clone(), item.done)),
        )
        .into_any_element(),
        AnswerBlock::Progress { id, items, .. } => progress(&base(id, "progress"), items, cx),
        AnswerBlock::Text { id, text, .. } => MarkdownContent::new(base(id, "text"), text.clone())
            .density(Density::Compact)
            .into_any_element(),
        AnswerBlock::Quote {
            id,
            text,
            cite,
            source,
            ..
        } => quote(
            &base(id, "quote"),
            text,
            cite.as_deref(),
            source.as_deref(),
            cx,
        ),
        AnswerBlock::Image {
            id,
            caption,
            source,
            ..
        } => image(
            &base(id, "image"),
            caption.as_deref(),
            source.as_deref(),
            cx,
        ),
        AnswerBlock::Facts { id, items, .. } => facts(&base(id, "facts"), items, cx),
        AnswerBlock::Metrics { id, items, .. } => metrics(&base(id, "metrics"), items, cx),
        AnswerBlock::Callout { tone, text, .. } => {
            Notice::new(callout_tone(tone.as_ref()), text.clone()).into_any_element()
        }
        AnswerBlock::Actions { id, items, .. } => actions(&base(id, "actions"), items, cx),
        _ => div().into_any_element(),
    }
}

/// The block's element id: its own id, else its type.
fn base(id: &Option<String>, kind: &str) -> SharedString {
    format!("answer-{kind}-{}", id.as_deref().unwrap_or_default()).into()
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

fn image(
    base: &SharedString,
    caption: Option<&str>,
    source: Option<&str>,
    _cx: &mut App,
) -> AnyElement {
    let mut frame = Stack::new().gap(Space::Xs).child(
        MediaFrame::new(ElementId::Name(format!("{base}-frame").into()))
            .aspect(Aspect::Square)
            .placeholder(),
    );
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

/// `AnswerSourceLine`: the source's site and check time as a text link; nothing without a source.
fn source_line(id: ElementId, source: Option<&str>, checked: Option<&str>) -> Option<AnyElement> {
    let source = source.filter(|source| !source.is_empty())?;
    let site = url::Url::parse(source).ok().and_then(|url| {
        url.host_str()
            .map(|host| host.trim_start_matches("www.").to_string())
    })?;
    let checked = checked
        .and_then(|raw| chrono::DateTime::parse_from_rfc3339(raw).ok())
        .map(|date| date.format("%Y-%m-%d").to_string());
    let text = [Some(site), checked]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" · ");
    let url = source.to_string();
    Some(
        Clickable::new(id)
            .variant(ClickableVariant::Text)
            .on_click(move |_, _, cx| cx.open_url(&url))
            .child(Typo::caption(text).tone(Tone::Tertiary))
            .into_any_element(),
    )
}
