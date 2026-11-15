//! The shell's side of the management surfaces (`store.ts` `setView`, `openProjectDashboard`,
//! `openSession`, `openSessionObserver`/`goBack`/`close`, `openArtifact`; `canonEvents.ts`):
//! the view and the page it shows, the leave guard, the composer on the dashboard (D4), the
//! session observer, and the live topics fed from the App stream.
use std::rc::Rc;

use butler_ds::ui::toast::{self, Toast};
use gpui::{
    AnyElement, AnyView, App, AppContext as _, Context, Entity, SharedString, Subscription, Window,
};

use super::Shell;
use super::navigation::Navigation;
use crate::ui::i18n::manage::words;
use crate::ui::manage::canon::plan::CanonTrustDialog;
use crate::ui::manage::{
    self, LibraryView, ManageCtx, ManageEvent, ManageLive, ManageState, Proceed, Topic, View, route,
};
use crate::ui::observer::{ObserverEvent, SessionObserver};
use crate::ui::source::sidebar::DraftTarget;
use crate::ui::source::wire::{AppEventEnvelope, ProjectDashboardDocument};
use crate::ui::viewer;

/// An observed session and the turn it scrolls to.
type Observed = (SharedString, Option<SharedString>);

/// The session observer and the sessions it showed before (`observerHistory`).
struct Observer {
    view: Entity<SessionObserver>,
    current: Observed,
    history: Vec<Observed>,
    _events: Subscription,
}

/// The management side of the shell.
pub(super) struct Manage {
    state: Entity<ManageState>,
    live: Entity<ManageLive>,
    /// The page shown and its remount key ([`manage::page_key`]).
    page: Option<(SharedString, AnyView)>,
    observer: Option<Observer>,
    /// `pendingProjectDocumentAttachment`: attached once the project's new chat is the draft.
    pending_document: Option<(SharedString, ProjectDashboardDocument)>,
    /// `CanonTrustDialog`: one per window, opened by the agent's trust request.
    pub(super) canon_trust: Entity<CanonTrustDialog>,
}

impl Shell {
    pub(super) fn new_manage(
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> (Manage, Subscription) {
        let state = cx.new(|_| ManageState::default());
        let live = cx.new(|_| ManageLive::default());
        let events = cx.subscribe_in(&state, window, Self::on_manage);
        let canon_trust = cx.new(|cx| CanonTrustDialog::new(&live, cx));
        let manage = Manage {
            state,
            live,
            page: None,
            observer: None,
            pending_document: None,
            canon_trust,
        };
        (manage, events)
    }

    pub(crate) fn manage_ctx(&self) -> ManageCtx {
        ManageCtx {
            state: self.manage.state.clone(),
            live: self.manage.live.clone(),
        }
    }

    pub(crate) fn view(&self, cx: &App) -> View {
        self.manage.state.read(cx).view.clone()
    }

    /// The conversation is the view (`view.kind === "session"`).
    pub(crate) fn on_session(&self, cx: &App) -> bool {
        self.manage.state.read(cx).view == View::Session
    }

    /// `routeActiveChatId`: the open session while the conversation is the view.
    pub(crate) fn route_chat(&self, cx: &App) -> Option<&str> {
        self.store
            .selected()
            .filter(|_| self.on_session(cx))
            .map(|chat| chat.session.0.as_ref())
    }

    /// The project whose dashboard is the view; the composer then writes its new chats (D4).
    pub(super) fn dashboard_project(&self, cx: &App) -> Option<SharedString> {
        match &self.manage.state.read(cx).view {
            View::ProjectDashboard { project, .. } => Some(project.clone()),
            _ => None,
        }
    }

    pub(super) fn bump_topic(&self, topic: Topic, cx: &mut App) {
        self.manage.live.update(cx, |live, cx| live.bump(topic, cx));
    }

    fn on_manage(
        &mut self,
        _: &Entity<ManageState>,
        event: &ManageEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            ManageEvent::SetView(view) => self.set_view(view.clone(), window, cx),
            ManageEvent::OpenProjectDashboard(project) => {
                self.open_project_dashboard(project.clone(), window, cx);
            }
            ManageEvent::OpenSession(id) => {
                self.navigate(Navigation::Session(id.to_string()), window, cx);
            }
            ManageEvent::OpenConversationLink(url) => {
                let session = self.store.selected().map(|chat| chat.session.0.clone());
                crate::ui::browser::open_conversation_link(session.as_deref(), url, cx);
            }
            ManageEvent::OpenNewChat => {
                self.sidebar.new_chat_parent = None;
                self.open_chat(None, window, cx);
            }
            ManageEvent::OpenProjectChat(project) => {
                self.open_sidebar_draft(Some(DraftTarget::Project(project.to_string())), cx);
            }
            ManageEvent::StartProjectChatWithDocument { project, document } => {
                self.manage.pending_document = Some((project.clone(), document.as_ref().clone()));
                self.open_sidebar_draft(Some(DraftTarget::Project(project.to_string())), cx);
            }
            ManageEvent::OpenSettings(section) => {
                let section = section.clone();
                self.guarded(move |s, w, cx| s.open_settings(&section, w, cx), window, cx);
            }
            ManageEvent::OpenObserver { session, turn } => {
                self.open_observer(session.clone(), turn.clone(), window, cx);
            }
            ManageEvent::OpenArtifact { session, entry } => {
                viewer::open(cx, session, entry.clone());
                self.set_view(View::Session, window, cx);
            }
            ManageEvent::SetLeftOpen(open) => {
                self.sidebar_open = *open;
                cx.notify();
            }
            ManageEvent::RefreshNavigation => self.refresh_sidebar(cx),
            // CARVE-OUT(G-cef): `attachLibrary` writes the conversation draft's
            // `element_attachments`, which the composer gains with the in-app browser's element
            // picks; until then the drop says so.
            ManageEvent::AttachLibrary { .. } => {
                toast::show(cx, Toast::message(self.theme.strings.not_yet));
            }
        }
    }

    /// `leaveCanonEditor`: `then` runs now, or once the page's leave guard lets it.
    fn guarded(
        &mut self,
        then: impl FnOnce(&mut Self, &mut Window, &mut Context<Self>) + 'static,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(guard) = self.manage.state.read(cx).leave_guard.clone() else {
            then(self, window, cx);
            return;
        };
        let shell = cx.entity().downgrade();
        let proceed: Proceed = Box::new(move |window, cx| {
            let _ = shell.update(cx, |this, cx| then(this, window, cx));
        });
        window.defer(cx, move |window, cx| guard(proceed, window, cx));
    }

    /// `setView` (behind the leave guard).
    pub(crate) fn set_view(&mut self, view: View, window: &mut Window, cx: &mut Context<Self>) {
        self.guarded(move |s, w, cx| s.show_view_now(&view, w, cx), window, cx);
    }

    /// Stores `view`, drops a page whose key changed (with the guard it set) and hands the
    /// composer to the dashboard; true when a new page must be built.
    fn store_view(&mut self, view: View, cx: &mut Context<Self>) -> bool {
        if self.manage.state.read(cx).view == view {
            return false;
        }
        let key = manage::page_key(&view);
        let rebuild = key.as_ref() != self.manage.page.as_ref().map(|(key, _)| key);
        let composer = matches!(view, View::ProjectDashboard { .. })
            .then(|| AnyView::from(self.composer.clone()));
        self.manage.state.update(cx, |state, cx| {
            state.view = view;
            state.composer = composer;
            if rebuild {
                state.leave_guard = None;
            }
            cx.notify();
        });
        if rebuild {
            self.manage.page = None;
        }
        self.sync_composer(cx);
        cx.notify();
        rebuild && key.is_some()
    }

    /// Shows `view` now (past the guard). The conversation takes the composer back.
    fn show_view_now(&mut self, view: &View, window: &mut Window, cx: &mut Context<Self>) {
        let was_session = self.on_session(cx);
        if self.store_view(view.clone(), cx) {
            let ctx = self.manage_ctx();
            self.manage.page = manage::page_key(view).zip(manage::page(view, ctx, window, cx));
        }
        if !was_session && *view == View::Session {
            self.composer.update(cx, |c, cx| c.engage(window, cx));
        }
    }

    /// A chat was opened (`openSession`): the conversation is the view and the observer closes.
    pub(crate) fn chat_opened(&mut self, cx: &mut Context<Self>) {
        self.manage.observer = None;
        self.store_view(View::Session, cx);
    }

    /// `openProjectDashboard`: the dashboard's activation moves its topic, and the sidebar
    /// closes unless the window is wide (expanded mode).
    pub(crate) fn open_project_dashboard(
        &mut self,
        project: SharedString,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.guarded(
            move |this, window, cx| {
                this.bump_topic(Topic::Dashboard(project.clone()), cx);
                let view = View::ProjectDashboard {
                    project,
                    epic: None,
                };
                this.show_view_now(&view, window, cx);
                if f32::from(window.viewport_size().width) <= 1023. {
                    this.sidebar_open = false;
                }
                cx.notify();
            },
            window,
            cx,
        );
    }

    /// `openPlanOverview`: the project's dashboard, then its plan overview.
    pub(crate) fn open_plan_overview(
        &mut self,
        project: SharedString,
        plan: Option<SharedString>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.open_project_dashboard(project.clone(), window, cx);
        self.set_view(View::PlanOverview { project, plan }, window, cx);
    }

    /// `LibraryEntry`: the 서랍; a drawer sidebar closes.
    pub(crate) fn open_library(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.set_view(View::Library(LibraryView::default()), window, cx);
        if f32::from(window.viewport_size().width) <= 640. {
            self.sidebar_open = false;
            cx.notify();
        }
    }

    /// The management page with the live connection notice in the shell card; `None` while
    /// the conversation is the view.
    pub(super) fn manage_page(&self) -> Option<AnyView> {
        self.manage.page.as_ref().map(|(_, page)| page.clone())
    }

    /// The titlebar back of a nested view (`useTitlebarBack`): the label and whether there is
    /// one.
    pub(super) fn back_label(&self, cx: &App) -> Option<String> {
        let parent = route::parent(&self.view(cx))?;
        let lang = self.theme.strings.locale.ds_lang();
        let title = route::nested_title(&parent, lang, cx).unwrap_or_default();
        Some(words(lang).back(&title))
    }

    /// Up one level (the titlebar back, `mod+[`, `alt+←`).
    pub(super) fn titlebar_back(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.settings_view.is_some() {
            return;
        }
        match route::parent(&self.view(cx)) {
            Some(route::Parent::View(view)) => self.set_view(view, window, cx),
            Some(route::Parent::Settings(section)) => {
                self.guarded(move |s, w, cx| s.open_settings(section, w, cx), window, cx);
            }
            None => {}
        }
    }

    /// `openSessionObserver`: the observed session before goes onto the back history.
    fn open_observer(
        &mut self,
        session: SharedString,
        turn: Option<SharedString>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some(observer) = &mut self.manage.observer {
            if observer.current.0 != session {
                observer.history.push(observer.current.clone());
            }
            observer.current = (session.clone(), turn.clone());
            observer
                .view
                .update(cx, |view, cx| view.show(session, turn, cx));
        } else {
            let live = self.manage.live.clone();
            let shown = (session.clone(), turn.clone());
            let view = cx.new(|cx| SessionObserver::new(session, turn.as_ref(), live, window, cx));
            let events = cx.subscribe_in(&view, window, Self::on_observer);
            self.manage.observer = Some(Observer {
                view,
                current: shown,
                history: Vec::new(),
                _events: events,
            });
        }
        self.sync_observer(cx);
        cx.notify();
    }

    /// The observer's Back button and the chat it was opened from.
    fn sync_observer(&mut self, cx: &mut Context<Self>) {
        let parent = self
            .store
            .selected()
            .map(|chat| SharedString::from(chat.session.0.to_string()));
        if let Some(observer) = &self.manage.observer {
            let can_go_back = !observer.history.is_empty();
            observer.view.update(cx, |view, cx| {
                view.set_can_go_back(can_go_back, cx);
                view.set_parent(parent);
            });
        }
    }

    fn on_observer(
        &mut self,
        _: &Entity<SessionObserver>,
        event: &ObserverEvent,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            // `goBackSessionObserver`: the session observed before, if any.
            ObserverEvent::Back => {
                if let Some(observer) = &mut self.manage.observer
                    && let Some(previous) = observer.history.pop()
                {
                    observer.current = previous.clone();
                    let (session, turn) = previous;
                    observer
                        .view
                        .update(cx, |view, cx| view.show(session, turn, cx));
                }
            }
            ObserverEvent::Close => self.manage.observer = None,
        }
        self.sync_observer(cx);
        cx.notify();
    }

    pub(super) fn render_observer(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let view = self.manage.observer.as_ref()?.view.clone();
        Some(view.update(cx, |view, cx| view.render_dialog(window, cx)))
    }

    /// The store's navigation goes to the pages when it changed.
    pub(crate) fn push_navigation(&mut self, cx: &mut Context<Self>) {
        let next = self.store.navigation.view.as_ref();
        if self.manage.state.read(cx).navigation.as_deref() == next {
            return;
        }
        let next = next.cloned().map(Rc::new);
        self.manage.state.update(cx, |state, cx| {
            state.navigation = next;
            cx.notify();
        });
    }

    /// One committed App event: the live topics, and an epic deleted while the dashboard shows
    /// it leaves the view (`canonEvents.ts:15-19`).
    pub(super) fn manage_live_event(&mut self, event: &AppEventEnvelope, cx: &mut Context<Self>) {
        if matches!(
            event.r#type.as_str(),
            "session.created" | "session.updated" | "session.permanently_deleted"
        ) {
            self.push_navigation(cx);
        }
        let navigation = self.manage.state.read(cx).navigation.clone();
        self.manage.live.update(cx, |live, cx| {
            live.publish(event, navigation.as_deref(), cx);
        });
        if event.r#type != "canon.changed" || event.payload["deleted"] != true {
            return;
        }
        if let View::ProjectDashboard {
            project,
            epic: Some(epic),
        } = self.view(cx)
            && event.payload["id"].as_str() == Some(epic.as_ref())
        {
            let view = View::ProjectDashboard {
                project,
                epic: None,
            };
            self.manage
                .state
                .update(cx, |_, cx| cx.emit(ManageEvent::SetView(view)));
        }
    }

    /// `usePendingProjectDocumentAttachment`: the document joins the project's new chat draft.
    pub(super) fn attach_pending_document(&mut self, cx: &mut Context<Self>) {
        let ready = match (&self.manage.pending_document, &self.sidebar.new_chat_parent) {
            (Some((project, _)), Some(DraftTarget::Project(target))) => {
                project.as_ref() == target.as_str()
                    && self.store.selected().is_none()
                    && self.on_session(cx)
            }
            _ => false,
        };
        if let Some((_, document)) = self.manage.pending_document.take_if(|_| ready) {
            self.composer
                .update(cx, |composer, cx| composer.add_document(&document, cx));
        }
    }
}
