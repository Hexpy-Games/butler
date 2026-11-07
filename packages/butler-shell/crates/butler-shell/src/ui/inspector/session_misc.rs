//! `BrowserSection`, `ContextCompact` and `SessionInfoActions`.
use butler_ds::tokens::Color;
use butler_ds::ui::blocks::key_value_row::{Detail, KeyValueRow, SwatchPattern, ValueSize};
use butler_ds::ui::button::{self, Button, Size as ButtonSize, Variant};
use butler_ds::ui::collapsible::Collapsible;
use butler_ds::ui::context::{Ds, Lang};
use butler_ds::ui::icon_button::{IconButton, Pane, Tone as IconTone};
use butler_ds::ui::presence::{Presence, PresenceMotion};
use butler_ds::ui::Icon;
use butler_ds::ui::layout::{Box as DsBox, Cross, Justify, Space, Stack};
use butler_ds::ui::tooltip::{Side, Tooltip};
use butler_ds::ui::typo::{Tone, Typo};
use std::rc::Rc;

use gpui::{
    AnyElement, App, Hsla, IntoElement as _, ParentElement as _, SharedString, Styled as _, Window,
    div, px, relative,
};

use super::InspectorCtx;
use crate::ui::composer::context::timeline::usage_tokens;
use crate::ui::i18n::session_info::SessionInfo;
use crate::ui::source::wire::{ContextDetailsView, ContextUsageCategory};

/// The browser section: `None` until P5 (the agent browser, LiveTabList and live frames).
pub(crate) fn browser_section(
    ctx: &InspectorCtx<'_>,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    let _ = (ctx, window, cx);
    None
}

const GROUP_IDS: [&str; 5] = ["conversation", "memory", "rules", "base", "reserve"];

/// `ITEM_GROUP`: the group an item id belongs to; unknown ids are basics.
fn item_group(id: &str) -> &'static str {
    match id {
        "working" | "current-input" => "conversation",
        "retrieved" | "references" | "live-config" => "memory",
        "output-reserve" | "tool-reserve" | "compaction-reserve" => "reserve",
        _ => "base",
    }
}

struct Group<'a> {
    id: &'static str,
    items: Vec<&'a ContextUsageCategory>,
    tokens: i64,
}

fn group_context(context: &ContextDetailsView) -> Vec<Group<'_>> {
    let mut groups: Vec<Group<'_>> = GROUP_IDS
        .iter()
        .map(|id| Group {
            id,
            items: Vec::new(),
            tokens: 0,
        })
        .collect();
    for item in &context.categories {
        let id = item_group(&item.id);
        if let Some(group) = groups.iter_mut().find(|group| group.id == id) {
            group.items.push(item);
            group.tokens += item.used_tokens;
        }
    }
    groups
}

/// `buildContextChart` over the groups (reserve excluded): the largest group first takes the
/// occupied tokens, each with the next chart colour; the rest of the budget is free.
fn chart_segments(context: &ContextDetailsView, groups: &[Group<'_>]) -> Vec<(Option<&'static str>, f64)> {
    let mut sorted: Vec<&Group<'_>> = groups.iter().filter(|group| group.id != "reserve").collect();
    sorted.sort_by_key(|group| std::cmp::Reverse(group.tokens));
    let budget = context.budget_tokens.max(0);
    let mut remaining = budget.min(context.used_tokens.max(0));
    let mut segments = Vec::new();
    let mut occupied = 0;
    for group in sorted {
        let value = group.tokens.max(0).min(remaining);
        remaining -= value;
        occupied += value;
        segments.push((Some(group.id), value as f64));
    }
    segments.push((None, (budget - occupied).max(0) as f64));
    segments
}

fn chart_color(index: usize, ds: &Ds) -> Hsla {
    ds.color(match index % 6 {
        0 => Color::ContextChart1,
        1 => Color::ContextChart2,
        2 => Color::ContextChart3,
        3 => Color::ContextChart4,
        4 => Color::ContextChart5,
        _ => Color::ContextChart6,
    })
}

/// `ContextBar`: the stacked occupied-and-free bar. Returns the bar and each group's colour.
fn context_bar(
    context: &ContextDetailsView,
    groups: &[Group<'_>],
    ds: &Ds,
) -> (AnyElement, Vec<(&'static str, Hsla)>) {
    let segments = chart_segments(context, groups);
    let total: f64 = segments.iter().map(|(_, value)| value).sum();
    let mut colors = Vec::new();
    let mut bar = div().flex().flex_row().w_full().h(px(12.)).rounded(px(6.)).overflow_hidden();
    for (index, (group, value)) in segments.iter().enumerate() {
        if *value <= 0. || total <= 0. {
            continue;
        }
        let color = match group {
            Some(id) => {
                let color = chart_color(index, ds);
                colors.push((*id, color));
                color
            }
            None => ds.color(Color::ContextChartFree),
        };
        bar = bar.child(div().h_full().w(relative((*value / total).to_string().parse::<f32>().unwrap_or_default())).bg(color));
    }
    let frame = div().flex().items_center().w_full().h(px(20.)).child(bar);
    (frame.into_any_element(), colors)
}

fn compact_tokens(value: i64, lang: Lang) -> String {
    usage_tokens(value as f64, lang)
}

/// `GroupItems`: the items of one group under its row.
fn group_items(group: &Group<'_>, lang: Lang, copy: &SessionInfo) -> AnyElement {
    let mut stack = Stack::new().gap(Space::Xs);
    for item in &group.items {
        let (label, description) = copy
            .items
            .iter()
            .find(|(id, _, _)| *id == item.id)
            .map_or((item.label.as_str(), item.safe_description.as_str()), |(_, label, description)| {
                (*label, *description)
            });
        stack = stack.child(
            KeyValueRow::new(label.to_owned(), compact_tokens(item.used_tokens, lang))
                .description(description.to_owned())
                .detail(Detail::RowStart)
                .value_size(ValueSize::Caption),
        );
    }
    DsBox::new().padding_start(Space::Lg).child(stack).into_any_element()
}

/// One group's row, hint tooltip and items.
fn group_row(
    group: &Group<'_>,
    colors: &[(&'static str, Hsla)],
    open: bool,
    lang: Lang,
    copy: &SessionInfo,
    ds: &Ds,
) -> AnyElement {
    let (_, label, hint) = copy.groups.iter().find(|(id, _, _)| *id == group.id).copied().unwrap_or(("", "", ""));
    let mut row = KeyValueRow::new(label, compact_tokens(group.tokens, lang)).value_size(ValueSize::Caption);
    if group.id == "reserve" {
        row = row.swatch_color(ds.color(Color::ContextChartFree)).swatch_pattern(SwatchPattern::Hatched);
    } else if let Some((_, color)) = colors.iter().find(|(id, _)| *id == group.id) {
        row = row.swatch_color(*color);
    }
    Stack::new()
        .gap(Space::Xs)
        .child(
            Tooltip::new(SharedString::from(format!("context-group-hint-{}", group.id)))
                .label(hint)
                .side(Side::Left)
                .child(div().child(row)),
        )
        .child(
            Collapsible::new(SharedString::from(format!("context-group-items-{}", group.id)), open)
                .child(group_items(group, lang, copy)),
        )
        .into_any_element()
}

/// The compact context usage; `None` when there is nothing to show.
pub(crate) fn context_compact(
    ctx: &InspectorCtx<'_>,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyElement> {
    let context = ctx.view.context.as_ref()?;
    let copy = SessionInfo::get(cx);
    let state = window.use_keyed_state(
        SharedString::from(format!("context-compact-open-{}", ctx.view.session_id)),
        cx,
        |_, _| false,
    );
    let open = *state.read(cx);
    let ds = Ds::get(cx);
    let lang = ds.lang();
    let groups = group_context(context);
    let (bar, colors) = context_bar(context, &groups, ds);
    let mut rows = Stack::new().gap(if open { Space::Md } else { Space::Xs });
    for group in &groups {
        rows = rows.child(group_row(group, &colors, open, lang, copy, ds));
    }
    let compact_at = context
        .auto_compact_at_tokens
        .map(|tokens| copy.context_compact_at.replace("{value}", &compact_tokens(tokens, lang)));
    let toggle = Button::new(SharedString::from(format!("context-compact-toggle-{}", ctx.view.session_id)))
        .variant(Variant::Link)
        .size(ButtonSize::Xs)
        .text(if open { copy.context_less } else { copy.context_more })
        .on_click(move |_, _, cx| {
            state.update(cx, |open, cx| {
                *open = !*open;
                cx.notify();
            });
        });
    let footer = Stack::row()
        .justify(Justify::Between)
        .cross(Cross::Center)
        .gap(Space::Sm)
        .child(match compact_at {
            Some(text) => Typo::caption(text).tone(Tone::Secondary).into_any_element(),
            None => div().into_any_element(),
        })
        .child(toggle);
    Some(Stack::new().gap(Space::Sm).child(bar).child(rows).child(footer).into_any_element())
}

pub(crate) type SessionActionHandler = Rc<dyn Fn(&mut Window, &mut App)>;

/// What the shell hands the session actions row: its state and handlers. The task graph button
/// shows when `on_open_task_graph` is set.
pub(crate) struct SessionInfoActionsProps {
    pub(crate) open: bool,
    pub(crate) on_toggle: SessionActionHandler,
    pub(crate) on_open_task_graph: Option<SessionActionHandler>,
    pub(crate) indicator: bool,
    pub(crate) has_ids: bool,
}

/// The session actions row.
pub(crate) fn session_info_actions(
    ctx: &InspectorCtx<'_>,
    props: SessionInfoActionsProps,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let _ = (window, ctx);
    let copy = SessionInfo::get(cx);
    let mut row = button::container(ButtonSize::IconSm);
    if let Some(open_graph) = props.on_open_task_graph {
        row = row.child(
            IconButton::new("task-graph-open", copy.task_graph_title)
                .glyph(Icon::Blocks)
                .on_click(move |_, window, cx| open_graph(window, cx)),
        );
    }
    let on_toggle = props.on_toggle;
    let mut toggle = IconButton::new("session-info-toggle", copy.title)
        .glyph(Icon::AppleReminder)
        .pane(Pane::Aside)
        .pressed(props.open)
        .tone(if props.open { IconTone::Butler } else { IconTone::Default })
        .on_click(move |_, window, cx| on_toggle(window, cx));
    if props.indicator {
        toggle = toggle.indicator();
    }
    row.child(
        Presence::new("session-info-toggle-presence", props.has_ids)
            .motion(PresenceMotion::Fade)
            .child(toggle),
    )
    .into_any_element()
}
