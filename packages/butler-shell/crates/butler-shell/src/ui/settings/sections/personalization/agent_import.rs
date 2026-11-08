//! Import from other AI tools (`AgentImportSection.tsx`, `agentImportApi.ts`,
//! `components/imports/useAgentImport.ts`). The detected tools and the import run through the
//! app's admin credential; the page keeps counts only.
use butler_ds::ui::blocks::empty_line::EmptyLine;
use butler_ds::ui::blocks::list_row::ListRow;
use butler_ds::ui::blocks::settings_section::{
    SettingsSection, SettingsSectionKind, SettingsSectionState,
};
use butler_ds::ui::button::{self, Button, Size, Variant};
use butler_ds::ui::context::{Ds, Lang};
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::layout::{Cross, Inline, MinWidth, Space, Stack, StackItem, WithItem as _};
use butler_ds::ui::spinner::Spinner;
use butler_ds::ui::typo::Typo;
use butler_shell_client::Error;
use gpui::prelude::FluentBuilder as _;
use gpui::{AnyElement, ClickEvent, Context, IntoElement as _, ParentElement as _, SharedString};
use serde::Deserialize;
use serde_json::json;

use super::PersonalizationPage;
use super::copy::{Words, import_found, import_result, words};
use crate::ui::Icon;
use crate::ui::settings::state::fetch;

/// A detected AI tool: what it holds, never a path or a secret.
#[derive(Clone, Deserialize)]
pub(super) struct Source {
    key: String,
    name: String,
    #[serde(default)]
    instructions: bool,
    #[serde(default)]
    servers: u64,
}

/// GET /security/agent-import/sources
#[derive(Deserialize)]
struct Sources {
    sources: Vec<Source>,
}

/// POST /security/agent-import/start
#[derive(Deserialize)]
pub(super) struct Counts {
    #[serde(default)]
    instructions: u64,
    #[serde(default)]
    servers: u64,
    #[serde(default)]
    needs_secret: u64,
    #[serde(default)]
    error: Option<String>,
}

/// `useAgentImport`: `sources` is `None` while loading.
#[derive(Default)]
pub(super) struct AgentImport {
    sources: Option<Vec<Source>>,
    busy: bool,
    error: bool,
    result: Option<Counts>,
    selected: Option<String>,
}

/// `resultText`
fn result_text(counts: &Counts, lang: Lang) -> String {
    if counts.instructions + counts.servers == 0 {
        words(lang).import_nothing_new.to_owned()
    } else {
        import_result(
            lang,
            counts.instructions,
            counts.servers,
            counts.needs_secret,
        )
    }
}

impl PersonalizationPage {
    pub(super) fn load_sources(cx: &mut Context<Self>) {
        fetch(
            cx,
            |client| async move { client.list_agent_import_sources().await },
            |this: &mut Self, result: Result<Sources, Error>, _| match result {
                Ok(view) => this.import.sources = Some(view.sources),
                Err(_) => {
                    this.import.sources = Some(Vec::new());
                    this.import.error = true;
                }
            },
        );
    }

    /// `run(key)`: one tool's import.
    fn run_import(&mut self, key: String, cx: &mut Context<Self>) {
        self.import.busy = true;
        self.import.error = false;
        self.import.selected = Some(key.clone());
        fetch(
            cx,
            move |client| async move { client.start_agent_import(&json!({ "source": key })).await },
            |this: &mut Self, result: Result<Counts, Error>, _| {
                this.import.busy = false;
                match result {
                    Ok(counts) => {
                        this.import.error = counts.error.is_some();
                        this.import.result = Some(counts);
                    }
                    Err(_) => this.import.error = true,
                }
            },
        );
        cx.notify();
    }

    /// `AgentRow`
    fn agent_row(&self, source: &Source, copy: &Words, cx: &mut Context<Self>) -> AnyElement {
        let lang = Ds::get(cx).lang();
        let key = source.key.clone();
        let empty = !source.instructions && source.servers == 0;
        let run = Button::new(SharedString::from(format!("agent-import-{}", source.key)))
            .size(Size::Sm)
            .variant(Variant::Outline)
            .text(copy.import_run)
            .when(self.import.busy || empty, Button::disabled)
            .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                this.run_import(key.clone(), cx);
            }));
        let row = ListRow::new(source.name.clone())
            .icon(icon(Icon::Bot, IconSize::Md, Ds::get(cx)))
            .description(import_found(lang, source.instructions, source.servers));
        Stack::row()
            .cross(Cross::Center)
            .gap(Space::Sm)
            .child(StackItem::new().grow().min_width(MinWidth::Zero).child(row))
            .child(run)
            .into_any_element()
    }

    /// The result of the last run, with its "more" action.
    fn import_result_block(
        &self,
        counts: &Counts,
        copy: &Words,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let lang = Ds::get(cx).lang();
        let title = self
            .import
            .sources
            .iter()
            .flatten()
            .find(|source| Some(&source.key) == self.import.selected.as_ref())
            .map_or_else(|| copy.import_run.to_owned(), |source| source.name.clone());
        let more = Button::new("agent-import-more")
            .size(Size::Sm)
            .variant(Variant::Ghost)
            .text(copy.import_more)
            .when(self.import.busy, Button::disabled)
            .on_click(cx.listener(|this, _: &ClickEvent, _, cx| {
                this.import.result = None;
                this.import.error = false;
                cx.notify();
            }));
        Stack::new()
            .gap(Space::Sm)
            .child(
                ListRow::new(title)
                    .icon(icon(Icon::Bot, IconSize::Md, Ds::get(cx)))
                    .description(result_text(counts, lang)),
            )
            .child(button::container(Size::Sm).child(more))
            .into_any_element()
    }

    /// The failure line, with Retry while a tool is selected and nothing came back.
    fn import_error_block(&self, copy: &Words, cx: &mut Context<Self>) -> AnyElement {
        let retry = self
            .import
            .selected
            .clone()
            .filter(|_| self.import.result.is_none());
        Stack::new()
            .gap(Space::Sm)
            .child(Typo::caption(copy.import_failed))
            .children(retry.map(|key| {
                button::container(Size::Sm).child(
                    Button::new("agent-import-retry")
                        .size(Size::Sm)
                        .variant(Variant::Outline)
                        .text(copy.import_retry)
                        .when(self.import.busy, Button::disabled)
                        .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                            this.run_import(key.clone(), cx);
                        })),
                )
            }))
            .into_any_element()
    }

    /// `AgentImportSection`; `rows` are its children (the memory import row).
    pub(super) fn agent_import_section(
        &self,
        copy: &Words,
        rows: Vec<AnyElement>,
        cx: &mut Context<Self>,
    ) -> SettingsSection {
        let import = &self.import;
        let mut section = SettingsSection::new(
            "agent-import",
            SettingsSectionKind::List,
            copy.section_agent_import,
        )
        .description(copy.import_purpose)
        .state(if import.sources.is_none() {
            SettingsSectionState::Loading
        } else {
            SettingsSectionState::Ready
        });
        if import.result.is_none() {
            match import.sources.as_deref() {
                Some([_, ..]) => {
                    for source in import.sources.iter().flatten() {
                        section = section.child(self.agent_row(source, copy, cx));
                    }
                }
                _ => section = section.child(EmptyLine::new(copy.import_no_sources)),
            }
        }
        section = section.children(rows);
        if import.busy {
            section = section.child(
                Inline::new()
                    .child(Spinner::new("agent-import-spinner"))
                    .child(Typo::body(copy.import_importing)),
            );
        }
        if let Some(counts) = &import.result {
            section = section.child(self.import_result_block(counts, copy, cx));
        }
        if import.error {
            section = section.child(self.import_error_block(copy, cx));
        }
        section
    }
}
