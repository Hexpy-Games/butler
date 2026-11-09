//! The command palette (`components/command/*` on the DS CommandPanel).
mod labels;

use butler_ds::ui::motion;
use std::time::Duration;

use butler_ds::ui::Icon;
use butler_ds::ui::blocks::command_panel::{CommandPaletteItem, CommandPalettePanel, highlight};
use butler_ds::ui::blocks::notice::{Notice, NoticeTone};
use butler_ds::ui::button::{Button, Size as ButtonSize, Variant};
use butler_ds::ui::context::{Ds, Lang};
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::typo::Typo;
use gpui::{
    AnyElement, Context, EventEmitter, FocusHandle, Focusable, IntoElement, Render, SharedString,
    Task, WeakEntity, Window,
};

use self::labels::{LOG_TRACE_COMMAND_ID, kind_key, local_results, result_subtitle, result_title};
use crate::ui::chat::AssistantHooks;
use crate::ui::i18n::palette::words;
use crate::ui::source::agent::Jobs;
use crate::ui::source::wire::{
    CommandPaletteResponse, CommandPaletteResult, CommandPaletteResultKind,
};

/// `setTimeout(search, 150)`
const SEARCH_DELAY: Duration = Duration::from_millis(150);

/// What the palette asks the shell to do. A navigation event closes the palette first; it is
/// followed by `Dismissed`.
#[derive(Clone, Debug)]
pub(crate) enum PaletteEvent {
    Dismissed,
    /// `session:<id>` -> `openSession`.
    OpenSession(String),
    /// `project:<id>` -> `openNewProjectChat`.
    OpenProjectChat(String),
    /// `automation:<id>` -> the schedule's detail view.
    OpenSchedule(String),
    /// `settings:<section>` -> `openSettings(section)`.
    OpenSettings(String),
    /// A space result: `useOrganization.reveal("g:<id>")`.
    RevealGroup(String),
    /// `openLatestLogTrace`: the open conversation's latest turn, else the log list.
    OpenLogTrace,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Status {
    Loading,
    Ready,
    Error,
}

/// `searchState`
struct SearchState {
    query: String,
    status: Status,
    results: Vec<CommandPaletteResult>,
}

/// `CommandPalette`.
pub(crate) struct CommandPalette {
    focus: FocusHandle,
    open: bool,
    query: String,
    search_state: SearchState,
    /// The pending search; replacing it cancels the previous one (`cancelled`).
    search_task: Option<Task<()>>,
}

impl CommandPalette {
    pub(crate) fn new(_window: &mut Window, cx: &mut Context<Self>) -> Self {
        Self {
            focus: cx.focus_handle(),
            open: false,
            query: String::new(),
            search_state: SearchState {
                query: String::new(),
                status: Status::Loading,
                results: Vec::new(),
            },
            search_task: None,
        }
    }

    /// Opens the palette (mod+K, the sidebar search row).
    pub(crate) fn open(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let _ = window;
        if self.open {
            return;
        }
        self.open = true;
        self.query.clear();
        self.search(cx);
        cx.notify();
    }

    /// `useCommandPaletteHotkey`: mod+K toggles.
    pub(crate) fn toggle(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.open {
            self.close(cx);
        } else {
            self.open(window, cx);
        }
    }

    fn close(&mut self, cx: &mut Context<Self>) {
        if !self.open {
            return;
        }
        self.open = false;
        self.search_task = None;
        cx.emit(PaletteEvent::Dismissed);
        cx.notify();
    }

    fn set_query(&mut self, query: String, cx: &mut Context<Self>) {
        if query == self.query {
            return;
        }
        self.query = query;
        self.search(cx);
        cx.notify();
    }

    /// The effect on `[query, retry, open, locale]`: loading, then the search after 150 ms.
    fn search(&mut self, cx: &mut Context<Self>) {
        let query = self.query.clone();
        self.search_state = SearchState {
            query: query.clone(),
            status: Status::Loading,
            results: Vec::new(),
        };
        self.search_task = Some(cx.spawn(async move |this, cx| {
            motion::sleep(cx.background_executor(), SEARCH_DELAY).await;
            let text = query.clone();
            let Ok(request) = this.update(cx, |_, cx| {
                Jobs::run(cx, move |client| async move {
                    client.search_command_palette(&text).await
                })
            }) else {
                return;
            };
            let response = request
                .await
                .and_then(Result::ok)
                .and_then(|value| serde_json::from_value::<CommandPaletteResponse>(value).ok());
            let _ = this.update(cx, |this, cx| {
                if this.search_state.query != query {
                    return;
                }
                this.search_state = match response {
                    Some(response) => SearchState {
                        query,
                        status: Status::Ready,
                        results: response.results,
                    },
                    None => SearchState {
                        query,
                        status: Status::Error,
                        results: Vec::new(),
                    },
                };
                cx.notify();
            });
        }));
    }

    /// The row's `onSelect`.
    fn select(&mut self, result: &CommandPaletteResult, cx: &mut Context<Self>) {
        let id = result.id.clone();
        let event = if result.kind == CommandPaletteResultKind::Group {
            Some(PaletteEvent::RevealGroup(id))
        } else if result.id == LOG_TRACE_COMMAND_ID {
            Some(PaletteEvent::OpenLogTrace)
        } else {
            navigation(&result.route)
        };
        if let Some(event) = event {
            cx.emit(event);
        }
        self.close(cx);
    }

    fn status(&self) -> Status {
        if self.search_state.query == self.query {
            self.search_state.status
        } else {
            Status::Loading
        }
    }

    /// `results`: the log trace command, the settings pages, then the server's results.
    fn results(&self, developer_mode: bool, lang: Lang) -> Vec<CommandPaletteResult> {
        let mut results = local_results(&self.query, developer_mode, lang);
        if self.status() == Status::Ready {
            results.extend(
                self.search_state
                    .results
                    .iter()
                    .filter(|result| result.kind != CommandPaletteResultKind::Settings)
                    .cloned(),
            );
        }
        results
    }
}

/// `navigateCommandResult`: the route prefix picks the target.
fn navigation(route: &str) -> Option<PaletteEvent> {
    let (prefix, rest) = route.split_once(':')?;
    let rest = rest.to_owned();
    match prefix {
        "session" => Some(PaletteEvent::OpenSession(rest)),
        "project" => Some(PaletteEvent::OpenProjectChat(rest)),
        "automation" => Some(PaletteEvent::OpenSchedule(rest)),
        "settings" => Some(PaletteEvent::OpenSettings(rest)),
        _ => None,
    }
}

/// `CommandIcon`
fn command_icon(kind: &CommandPaletteResultKind) -> Icon {
    match kind {
        CommandPaletteResultKind::Automation => Icon::Clock3,
        CommandPaletteResultKind::Project => Icon::Briefcase,
        CommandPaletteResultKind::ProjectSession => Icon::Notebook,
        CommandPaletteResultKind::Group => Icon::Folder,
        CommandPaletteResultKind::Settings => Icon::Settings,
        CommandPaletteResultKind::Chat | CommandPaletteResultKind::Unknown => Icon::PencilLine,
    }
}

/// The `feedback` slot: the failed-search notice with Try again, or the loading/empty caption.
fn feedback(
    status: Status,
    empty: bool,
    lang: Lang,
    this: &WeakEntity<CommandPalette>,
) -> Option<AnyElement> {
    let words = words(lang);
    if status == Status::Error {
        let this = this.clone();
        let retry = Button::new("palette-retry")
            .variant(Variant::Outline)
            .size(ButtonSize::Sm)
            .text(words.retry)
            .on_click(move |_, _, cx| {
                let _ = this.update(cx, CommandPalette::search);
            });
        return Some(
            Notice::new(NoticeTone::Error, words.failed)
                .action(retry)
                .into_any_element(),
        );
    }
    if status == Status::Loading || empty {
        let text = if status == Status::Loading {
            words.loading
        } else {
            words.empty
        };
        return Some(Typo::caption(text).into_any_element());
    }
    None
}

impl EventEmitter<PaletteEvent> for CommandPalette {}

impl Focusable for CommandPalette {
    fn focus_handle(&self, _cx: &gpui::App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for CommandPalette {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if !self.open {
            return gpui::div().into_any_element();
        }
        let lang = Ds::get(cx).lang();
        let copy = words(lang);
        let developer_mode = cx
            .try_global::<AssistantHooks>()
            .is_some_and(|hooks| hooks.developer_mode);
        let results = self.results(developer_mode, lang);
        let this = cx.entity().downgrade();
        let items: Vec<CommandPaletteItem> = results
            .into_iter()
            .map(|result| {
                let title = highlight(&result_title(&result, lang), &self.query, Ds::get(cx));
                let subtitle = SharedString::from(result_subtitle(&result, lang));
                let glyph = icon(command_icon(&result.kind), IconSize::Md, Ds::get(cx));
                let id = format!("{}-{}", kind_key(&result.kind), result.id);
                let target = this.clone();
                CommandPaletteItem::new(id, title, move |_, cx| {
                    let _ = target.update(cx, |this, cx| this.select(&result, cx));
                })
                .subtitle(subtitle)
                .icon(glyph)
            })
            .collect();
        let (change, close) = (this.clone(), this.clone());
        let mut panel =
            CommandPalettePanel::new("command-palette", copy.label, copy.placeholder, copy.close)
                .open(self.open)
                .query(self.query.clone(), move |text, _, cx| {
                    let text = text.to_owned();
                    let _ = change.update(cx, |this, cx| this.set_query(text, cx));
                })
                .on_close(move |_, cx| {
                    let _ = close.update(cx, CommandPalette::close);
                });
        if let Some(feedback) = feedback(self.status(), items.is_empty(), lang, &this) {
            panel = panel.feedback(feedback);
        }
        panel.items(items).into_any_element()
    }
}
