//! The settings screen (`SettingsView.tsx`, `useCompactSettingsPaneEntry.ts`,
//! `SettingsDetailHeader.tsx`, `SettingsDetailContent.tsx`): the shell's only child while open.
//! The navigation picks a section; the section's page is built when it becomes active and
//! dropped when the owner leaves it, as React unmounts it. Every page gets a [`SectionCtx`].
pub(crate) mod confirm;
pub(crate) mod controls;
mod nav;
pub(crate) mod sections;
pub(crate) mod state;

use std::rc::Rc;

use butler_ds::ui::blocks::settings_header::SettingsHeader;
use butler_ds::ui::blocks::settings_section::SettingsSectionLabels;
use butler_ds::ui::blocks::settings_shell::{CompactPane, SettingsShell};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon_button::IconButton;
use gpui::{
    AnyElement, AnyView, App, AppContext as _, Context, Entity, EventEmitter, FocusHandle,
    InteractiveElement as _, IntoElement, KeyDownEvent, ParentElement as _, Render, SharedString,
    Styled as _, Subscription, Window, div,
};
use serde_json::Value;

pub(crate) use sections::SectionId;
pub(crate) use state::{Save, SettingsEvent, SettingsState};

use crate::ui::Icon;
use crate::ui::i18n::settings::words;

/// What every section page gets. Cheap to clone.
#[derive(Clone)]
pub(crate) struct SectionCtx {
    pub(crate) state: Entity<SettingsState>,
}

impl SectionCtx {
    /// `settingsUIStore.update(patch, setSettings, opts)`.
    pub(crate) fn save(&self, patch: Value, opts: Save, cx: &mut App) {
        self.state
            .update(cx, |state, cx| state.save(patch, opts, cx));
    }

    /// `setModelCatalog` after a fresh `/model-catalog`.
    pub(crate) fn reload_catalog(&self, cx: &mut App) {
        self.state
            .update(cx, |_, cx| SettingsState::reload_catalog(cx));
    }

    /// settings.sectionState: the copy for `SettingsPage::labels`.
    pub(crate) fn labels(cx: &App) -> SettingsSectionLabels {
        let copy = words(Ds::get(cx).lang());
        SettingsSectionLabels::new()
            .loading(copy.state_loading)
            .error(copy.state_error)
            .retry(copy.state_retry)
            .empty(copy.state_empty)
    }

    /// `confirmAction`: `on_accept` runs only when the owner confirms.
    pub(crate) fn confirm(
        &self,
        request: confirm::Request,
        on_accept: impl FnOnce(&mut Window, &mut App) + 'static,
        cx: &mut App,
    ) {
        self.state.update(cx, |state, cx| {
            state.pending_confirm = Some(confirm::Pending {
                request,
                typed: String::new(),
                on_accept: Box::new(on_accept),
            });
            cx.notify();
        });
    }

    /// `setActiveSection` / `openSettings(id)`.
    pub(crate) fn open_section(&self, id: SectionId, cx: &mut App) {
        self.state
            .update(cx, |_, cx| cx.emit(SettingsEvent::Open(id)));
    }

    /// `openSession` + `closeSettings`.
    pub(crate) fn open_session(&self, id: SharedString, cx: &mut App) {
        self.state
            .update(cx, |_, cx| cx.emit(SettingsEvent::OpenSession(id)));
    }

    /// `openHistory("settings")`: Settings closes and the browser history page shows, with
    /// Settings › Browser as its parent.
    pub(crate) fn open_history(&self, cx: &mut App) {
        self.state
            .update(cx, |_, cx| cx.emit(SettingsEvent::OpenHistory));
    }

    /// `openRerun` (`RerunSetupField`): Settings closes and the setup shows again.
    pub(crate) fn rerun_setup(&self, cx: &mut App) {
        self.state
            .update(cx, |_, cx| cx.emit(SettingsEvent::RerunSetup));
    }

    /// A page inside the section, or back to the section (`None`).
    pub(crate) fn set_subpage(&self, subpage: Option<Subpage>, cx: &mut App) {
        self.state.update(cx, |state, cx| {
            state.subpage = subpage;
            cx.notify();
        });
    }
}

/// The header line of a [`Subpage`] (a breadcrumb).
pub(crate) type Secondary = Rc<dyn Fn(&mut Window, &mut App) -> AnyElement>;
/// A page action with no arguments (back, open the log list).
pub(crate) type Action = Rc<dyn Fn(&mut Window, &mut App)>;

/// A page inside a section (models add/edit, a log trace): the header's `secondary` and the
/// page key.
pub(crate) struct Subpage {
    pub(crate) key: SharedString,
    pub(crate) secondary: Secondary,
}

pub(crate) struct SettingsView {
    state: Entity<SettingsState>,
    section: SectionId,
    page: AnyView,
    compact: CompactPane,
    /// The navigation search.
    query: String,
    /// `autoOpenedSearchRef`: the search and page last opened as the only match.
    auto_opened: Option<String>,
    focus: FocusHandle,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<SettingsEvent> for SettingsView {}

impl SettingsView {
    /// Opens on `section`, showing `settings` (the shell's last `/settings`) until its own read
    /// lands. A compact window starts on the page unless it is General.
    pub(crate) fn new(
        section: SectionId,
        settings: Option<Rc<Value>>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let state = cx.new(|_| SettingsState::new(settings));
        state.update(cx, |_, cx| SettingsState::load(cx));
        let subscriptions = vec![
            cx.subscribe_in(&state, window, Self::on_state),
            cx.observe_in(&state, window, |this, _, window, cx| {
                this.leave_logs(window, cx);
                cx.notify();
            }),
        ];
        let ctx = SectionCtx {
            state: state.clone(),
        };
        let page = sections::page(section, ctx, window, cx);
        let focus = cx.focus_handle();
        focus.focus(window, cx);
        let mut view = Self {
            state,
            section,
            page,
            compact: if section == SectionId::General {
                CompactPane::Master
            } else {
                CompactPane::Detail
            },
            query: String::new(),
            auto_opened: None,
            focus,
            _subscriptions: subscriptions,
        };
        view.leave_logs(window, cx);
        view
    }

    /// Electron `connectorEvents.ts`: only the connections page observes these events.
    pub(crate) fn live_event(
        &mut self,
        event: &crate::ui::source::wire::AppEventEnvelope,
        cx: &mut Context<Self>,
    ) {
        if event.r#type == "connectors.changed" {
            self.state.update(cx, |state, cx| {
                state.connector_version = state.connector_version.wrapping_add(1);
                cx.notify();
            });
        }
    }

    /// Takes the keyboard back (Escape closes the screen), as after the command palette.
    pub(crate) fn focus(&self, window: &mut Window, cx: &mut App) {
        self.focus.focus(window, cx);
    }

    /// `changeSection`: another section's page replaces the current one; the compact window
    /// shows the page.
    pub(crate) fn show(&mut self, section: SectionId, window: &mut Window, cx: &mut Context<Self>) {
        self.compact = CompactPane::Detail;
        if section != self.section {
            self.section = section;
            self.state.update(cx, |state, _| state.subpage = None);
            let ctx = SectionCtx {
                state: self.state.clone(),
            };
            self.page = sections::page(section, ctx, window, cx);
        }
        cx.notify();
    }

    /// Logs exists only in developer mode: when it goes off, About shows instead.
    fn leave_logs(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.section == SectionId::Logs && !self.state.read(cx).developer_mode() {
            self.show(SectionId::About, window, cx);
        }
    }

    fn on_state(
        &mut self,
        _: &Entity<SettingsState>,
        event: &SettingsEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            SettingsEvent::Open(id) => self.show(*id, window, cx),
            other => cx.emit(other.clone()),
        }
    }

    /// The navigation search; a single matching page opens once per query.
    fn set_query(&mut self, query: String, window: &mut Window, cx: &mut Context<Self>) {
        self.query = query;
        let lang = Ds::get(cx).lang();
        let developer = self.state.read(cx).developer_mode();
        let normalized = self.query.trim().to_lowercase();
        let matching: Vec<SectionId> = sections::groups(developer, &self.query, lang)
            .into_iter()
            .flat_map(|(_, ids)| ids)
            .collect();
        let sole = match matching.as_slice() {
            [only] if !normalized.is_empty() => Some(*only),
            _ => None,
        };
        match sole {
            None => self.auto_opened = None,
            Some(id) => {
                let key = format!("{normalized}:{}", id.id());
                if self.auto_opened.as_deref() != Some(key.as_str()) {
                    self.auto_opened = Some(key);
                    if id != self.section {
                        self.show(id, window, cx);
                    }
                }
            }
        }
        cx.notify();
    }

    /// Escape closes, unless something inside (a dialog, a menu) handled it first.
    fn on_key(event: &KeyDownEvent, _: &mut Window, cx: &mut Context<Self>) {
        if event.keystroke.key == "escape" {
            cx.emit(SettingsEvent::Close);
        }
    }
}

impl Render for SettingsView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let lang = Ds::get(cx).lang();
        let copy = words(lang);
        let developer = self.state.read(cx).developer_mode();
        let index = sections::visible(developer)
            .iter()
            .position(|id| *id == self.section);
        let (title, description) = match index {
            Some(_) => {
                let section = self.section.copy(lang);
                (section.label, Some(section.description))
            }
            None => (copy.title, None),
        };
        let subpage = self
            .state
            .read(cx)
            .subpage
            .as_ref()
            .map(|subpage| (subpage.key.clone(), subpage.secondary.clone()));
        // React orders pages by index and a page keyed under the section (a log trace) at
        // index + 0.5; the DS order is whole.
        let nested = subpage
            .as_ref()
            .is_some_and(|(key, _)| key.as_ref() != self.section.id());
        let order = index.map_or(-1, |index| i32::try_from(index).unwrap_or(i32::MAX / 4)) * 2
            + i32::from(nested);
        let key: SharedString = subpage
            .as_ref()
            .map_or_else(|| self.section.id().into(), |(key, _)| key.clone());
        let mut header = SettingsHeader::new(title);
        if let Some(description) = description {
            header = header.description(description);
        }
        if let Some((_, secondary)) = subpage {
            header = header.secondary(secondary(window, cx));
        }
        let back = IconButton::new("settings-detail-back", copy.back)
            .glyph(Icon::ArrowLeft)
            .on_click(cx.listener(|this, _, _, cx| {
                this.compact = CompactPane::Master;
                cx.notify();
            }));
        let sidebar = nav::settings_sidebar(self.section, &self.query, developer, cx);
        let mut shell = SettingsShell::new("settings")
            .active()
            .compact_pane(self.compact)
            .page_title(title)
            .page_key(key)
            .page_order(order)
            .detail_navigation(back)
            .sidebar(sidebar)
            .detail_header(header)
            .detail(
                crate::ui::widgets::anchor(
                    div().w_full(),
                    &format!("settings-page-{}", self.section.id()),
                )
                .child(self.page.clone()),
            );
        if let Some(description) = description {
            shell = shell.page_description(description);
        }
        crate::ui::widgets::anchor(div(), "settings")
            .track_focus(&self.focus)
            .key_context("Settings")
            .on_key_down(cx.listener(|_, event, window, cx| Self::on_key(event, window, cx)))
            .size_full()
            .child(shell)
            .children(confirm::dialog(&self.state, window, cx))
    }
}
