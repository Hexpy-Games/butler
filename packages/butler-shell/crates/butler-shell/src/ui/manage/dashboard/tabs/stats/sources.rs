//! `management/ProjectStatisticSources.tsx`: the records behind a chart bar, a lane or a day.
use gpui::ParentElement as _;
use std::rc::Rc;

use butler_ds::ui::Icon;
use butler_ds::ui::blocks::nav_row::NavRow;
use butler_ds::ui::button::{Button, Variant};
use butler_ds::ui::context::{Ds, Lang};
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::layout::{Space, Stack};
use butler_ds::ui::separator::Separator;
use butler_ds::ui::typo::{Typo, Wrap};
use gpui::{App, ClickEvent, SharedString, Window};

use super::Stats;
use crate::ui::manage::dashboard::tabs::copy::words;
use crate::ui::manage::dashboard::tabs::format;

/// How many records a list shows at first and per "show more" (`useState(5)`, `+ 10`).
pub(super) const FIRST: usize = 5;
pub(super) const MORE: usize = 10;

/// The row of one record: its title, the conversation, the day and how long it took.
fn row(stats: &Rc<Stats>, key: &str, lang: Lang, cx: &App) -> Option<NavRow> {
    let source = stats.data.sources.get(key)?;
    let ds = Ds::get(cx);
    let day = if source.source.is_none() {
        format::date_short(&source.at, lang)
    } else {
        String::new()
    };
    let session = source
        .session
        .as_ref()
        .filter(|session| session.title != source.title)
        .map(|session| session.title.clone());
    let duration = source
        .duration_ms
        .map(|milliseconds| format::seconds(milliseconds, lang));
    let meta = [session, Some(day), duration]
        .into_iter()
        .flatten()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" · ");
    let glyph = if source.source.is_some() {
        Icon::FileText
    } else {
        Icon::MessageSquare
    };
    let (open, picked) = (stats.clone(), key.to_owned());
    Some(
        NavRow::new(SharedString::from(format!("source-{key}")), "")
            .label_element(
                Typo::text(source.title.clone())
                    .line_clamp(2)
                    .wrap(Wrap::Anywhere),
            )
            .icon(icon(glyph, IconSize::Md, ds))
            .multiline()
            .meta(Typo::caption(meta))
            .actions(icon(Icon::ChevronRight, IconSize::Md, ds))
            .on_click(move |_, window: &mut Window, cx| open.open(&picked, window, cx)),
    )
}

/// `ProjectStatisticSources`: `keys` without repeats, `limit` of them as rows, and `more` to show
/// ten more.
pub(super) fn source_list(
    id: &str,
    keys: &[String],
    limit: usize,
    stats: &Rc<Stats>,
    more: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    cx: &App,
) -> Stack {
    let lang = Ds::get(cx).lang();
    let copy = &words(lang).stats;
    let mut unique: Vec<&String> = Vec::new();
    for key in keys {
        if !unique.contains(&key) {
            unique.push(key);
        }
    }
    let rows = unique
        .iter()
        .take(limit)
        .filter_map(|key| row(stats, key, lang, cx))
        .collect::<Vec<_>>();
    let mut list = Stack::new()
        .gap(Space::Xs)
        .child(Typo::caption((copy.sources)(unique.len())))
        .children(rows);
    if unique.len() > limit {
        list = list.child(
            Button::new(SharedString::from(format!("{id}-more")))
                .variant(Variant::Inline)
                .text(words(lang).load_more)
                .on_click(more),
        );
    }
    Stack::new()
        .gap(Space::Md)
        .child(Separator::new().space(Space::None))
        .child(list)
}
