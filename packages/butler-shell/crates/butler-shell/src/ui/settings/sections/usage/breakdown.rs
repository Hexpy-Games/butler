//! `UsageBreakdown.tsx`: usage by chat, model and tool.
use std::collections::HashMap;
use std::rc::Rc;

use butler_ds::ui::blocks::progress_meter::ProgressMeter;
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::clickable::{Bleed, Clickable};
use butler_ds::ui::context::{Ds, Lang};
use butler_ds::ui::layout::{Box as DsBox, Cross, Justify, MinWidth, Space, Stack, WithItem as _};
use butler_ds::ui::skeleton::SkeletonRows;
use butler_ds::ui::tabs::{ListVariant, Tabs, TabsList, Trigger};
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{AnyElement, App, Context, ElementId, IntoElement as _, ParentElement as _, Window};

use super::UsagePage;
use super::copy::{Words, words};
use super::format::{count, meter_value, provider_name, time_of_ms};
use super::picker::{kind_label, session_title};
use super::wire::TopSession;
use crate::ui::chat::activity::tools::tool_label;
use crate::ui::composer::context::timeline::{usage_share, usage_tokens};
use crate::ui::composer::context::usage::now_ms;
use crate::ui::composer::decode_catalog;
use crate::ui::composer::menus::{ModelChoice, model_display_name};
use crate::ui::i18n::composer::usage::copy;

/// The chats listed before "View all".
const TOP_SESSIONS: usize = 6;

struct Row {
    id: String,
    title: String,
    description: String,
    value: f64,
}

type Select = Rc<dyn Fn(Option<String>, &mut Window, &mut App)>;

/// What a row list shows beside the rows themselves.
struct List<'a> {
    group: &'static str,
    total: f64,
    /// The values are call counts, not tokens.
    calls: bool,
    selected: Option<&'a str>,
    on_select: Option<Select>,
    lang: Lang,
}

/// `BreakdownRows`
fn rows(rows: &[Row], list: &List) -> AnyElement {
    let words = words(list.lang);
    if rows.is_empty() {
        return Typo::caption(words.no_records).into_any_element();
    }
    Stack::new()
        .gap(Space::Sm)
        .children(rows.iter().map(|row| {
            let share = if list.total > 0. {
                row.value / list.total
            } else {
                0.
            };
            let id = (ElementId::from(list.group), row.id.clone());
            let content = row_content(row, share, list, id.clone());
            match &list.on_select {
                Some(select) => {
                    let (select, next) = (
                        select.clone(),
                        (list.selected != Some(row.id.as_str())).then(|| row.id.clone()),
                    );
                    Clickable::new(id)
                        .bleed(Bleed::Inline)
                        .stretch()
                        .selected(list.selected == Some(row.id.as_str()))
                        .on_click(move |_, window, cx| select(next.clone(), window, cx))
                        .child(content)
                        .into_any_element()
                }
                None => content,
            }
        }))
        .into_any_element()
}

fn row_content(row: &Row, share: f64, list: &List, id: (ElementId, String)) -> AnyElement {
    let (words, lang) = (words(list.lang), list.lang);
    let value = if list.calls {
        (words.calls)(&count(row.value))
    } else {
        usage_tokens(row.value, lang)
    };
    let description = (!row.description.is_empty())
        .then(|| Typo::caption(row.description.clone()).tone(Tone::Primary));
    let text = Stack::new()
        .gap(Space::Xs)
        .grow()
        .min_width(MinWidth::Zero)
        .child(Typo::body(row.title.clone()).tone(Tone::Primary).truncate())
        .children(description);
    let numbers = Stack::new()
        .gap(Space::Xs)
        .cross(Cross::End)
        .child(Typo::body(value).tone(Tone::Primary).tabular())
        .child(
            Typo::caption(usage_share(share, lang))
                .tone(Tone::Primary)
                .tabular(),
        );
    DsBox::new()
        .padding_y(Space::Sm)
        .grow()
        .min_width(MinWidth::Zero)
        .child(
            Stack::new()
                .gap(Space::Xs)
                .grow()
                .min_width(MinWidth::Zero)
                .child(
                    Stack::row()
                        .cross(Cross::Start)
                        .justify(Justify::Between)
                        .wrap(false)
                        .child(text)
                        .child(numbers),
                )
                .child(ProgressMeter::new(id, meter_value(share * 100.)).bare()),
        )
        .into_any_element()
}

fn skeleton(id: &'static str) -> AnyElement {
    SkeletonRows::new(id).rows(3).into_any_element()
}

/// `catalog.models` and the runtime models by model ref and model id, the later winning.
fn models_by_id(state: &crate::ui::settings::SettingsState) -> HashMap<String, ModelChoice> {
    let catalog = state.catalog().and_then(decode_catalog);
    let mut by_id = HashMap::new();
    for model in catalog
        .map(|catalog| catalog.models)
        .unwrap_or_default()
        .into_iter()
        .chain(state.runtime_models())
    {
        by_id.insert(model.model_ref.to_string(), model.clone());
        by_id.insert(model.model_id.to_string(), model);
    }
    by_id
}

impl UsagePage {
    pub(super) fn breakdown(
        &self,
        sessions: &[TopSession],
        loading: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let lang = Ds::get(cx).lang();
        let words = words(lang);
        let view = self.view();
        let chats = if loading {
            skeleton("usage-chats-skeleton")
        } else {
            self.chats_panel(sessions, lang, cx)
        };
        let models = if loading {
            skeleton("usage-models-skeleton")
        } else {
            let by_id = models_by_id(self.ctx.state.read(cx));
            let total = view.map_or(0., |view| view.usage.model.totals.total_tokens);
            let list = List {
                group: "usage-model",
                total,
                calls: false,
                selected: None,
                on_select: None,
                lang,
            };
            rows(&self.model_rows(&by_id, lang), &list)
        };
        let tools = if loading {
            skeleton("usage-tools-skeleton")
        } else {
            let tool_rows = self.tool_rows(words, lang);
            let total: f64 = tool_rows.iter().map(|row| row.value).sum();
            let list = List {
                group: "usage-tool",
                total,
                calls: true,
                selected: None,
                on_select: None,
                lang,
            };
            rows(&tool_rows, &list)
        };
        Tabs::new("usage-breakdown")
            .gap(Space::Md)
            .default_value("chats")
            .list(
                TabsList::new(words.trend)
                    .variant(ListVariant::Line)
                    .triggers([
                        Trigger::new("chats", words.chats),
                        Trigger::new("models", words.models),
                        Trigger::new("tools", words.tools),
                    ]),
            )
            .panel("chats", chats)
            .panel("models", models)
            .panel("tools", tools)
            .into_any_element()
    }

    /// The chats, with "View all" when there are more than the list shows.
    fn chats_panel(
        &self,
        sessions: &[TopSession],
        lang: Lang,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let words = words(lang);
        let page = cx.entity().downgrade();
        let list = List {
            group: "usage-chat",
            total: self
                .all_view()
                .map_or(0., |view| view.usage.model.totals.total_tokens),
            calls: false,
            selected: self.session.as_deref(),
            on_select: Some(Rc::new({
                let page = page.clone();
                move |id, _, cx| {
                    let _ = page.update(cx, |this, cx| this.set_session(id, cx));
                }
            })),
            lang,
        };
        let mut column = Stack::new()
            .gap(Space::Sm)
            .child(rows(&self.session_rows(sessions, words, lang), &list));
        if sessions.len() > TOP_SESSIONS {
            column = column.child(
                Button::new("usage-view-all")
                    .size(Size::Xs)
                    .variant(Variant::Outline)
                    .text((words.view_all)(sessions.len()))
                    .on_click(move |_, _, cx| {
                        let _ = page.update(cx, |this, cx| {
                            this.picker.open = true;
                            cx.notify();
                        });
                    }),
            );
        }
        column.into_any_element()
    }

    /// The top chats, plus the scoped chat when it is not among them.
    fn session_rows(&self, sessions: &[TopSession], words: &Words, lang: Lang) -> Vec<Row> {
        let mut top: Vec<&TopSession> = sessions.iter().take(TOP_SESSIONS).collect();
        let extra = sessions
            .iter()
            .find(|item| Some(item.session_id.as_str()) == self.session.as_deref());
        if let Some(extra) = extra
            && !top.iter().any(|item| item.session_id == extra.session_id)
        {
            top.push(extra);
        }
        let now = now_ms();
        top.into_iter()
            .map(|session| {
                let mut details = vec![kind_label(&session.kind, words).to_owned()];
                details.extend(session.last_used_ms.map(|at| time_of_ms(at, now, lang)));
                Row {
                    id: session.session_id.clone(),
                    title: session_title(Some(session), words),
                    description: details.join(" · "),
                    value: session.total_tokens,
                }
            })
            .collect()
    }

    fn model_rows(&self, by_id: &HashMap<String, ModelChoice>, lang: Lang) -> Vec<Row> {
        let c = copy(lang);
        let Some(view) = self.view() else {
            return Vec::new();
        };
        let mut models: Vec<_> = view.usage.model.by_model.iter().collect();
        models.sort_by(|a, b| b.1.total_tokens.total_cmp(&a.1.total_tokens));
        models
            .into_iter()
            .map(|(id, usage)| {
                let model = by_id.get(id);
                let provider = model
                    .map(|model| model.provider_label.to_string())
                    .filter(|label| !label.is_empty())
                    .unwrap_or_else(|| provider_name(id.split('/').next().unwrap_or_default()));
                let cached = if usage.prompt_tokens > 0. {
                    (usage.cached_tokens / usage.prompt_tokens * 100.).round()
                } else {
                    0.
                };
                Row {
                    id: id.clone(),
                    title: model
                        .map_or_else(|| id.clone(), |model| model_display_name(model).to_string()),
                    description: format!(
                        "{provider} · {} · {} {cached}%",
                        (c.requests)(&count(usage.request_count)),
                        c.cached
                    ),
                    value: usage.total_tokens,
                }
            })
            .collect()
    }

    /// The tools by calls, with web search from its own counter when the tools do not list it.
    fn tool_rows(&self, words: &Words, lang: Lang) -> Vec<Row> {
        let Some(view) = self.view() else {
            return Vec::new();
        };
        let title =
            |id: &str| tool_label(lang, id).map_or_else(|| id.to_owned(), ToOwned::to_owned);
        let usage = &view.usage;
        let mut tools: Vec<_> = usage.tools.by_tool.iter().collect();
        tools.sort_by(|a, b| b.1.calls.total_cmp(&a.1.calls));
        let mut rows: Vec<Row> = tools
            .into_iter()
            .map(|(id, tool)| Row {
                id: id.clone(),
                title: title(id),
                description: (words.failures)(&count(tool.failures)),
                value: tool.calls,
            })
            .collect();
        if usage.filters.session_id.is_none()
            && usage.web_search.request_count > 0.
            && !usage.tools.by_tool.contains_key("web_search")
        {
            rows.push(Row {
                id: "web_search".to_owned(),
                title: title("web_search"),
                description: String::new(),
                value: usage.web_search.request_count,
            });
            rows.sort_by(|a, b| b.value.total_cmp(&a.value));
        }
        rows
    }
}
