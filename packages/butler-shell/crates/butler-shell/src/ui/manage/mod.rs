//! The management surfaces (`AppView` without the browser and settings, `app/types.ts:1863`):
//! the view model, the state every page observes, and the page switch of `AppShell.tsx:216-243`.
//! The shell owns the view; a page is built when its remount key ([`page_key`]) changes and reads
//! the current view from [`ManageCtx::view`] inside one key. Every page gets a [`ManageCtx`].
#![allow(dead_code, reason = "seam API: the P4 units call it; F6 removes this")]
pub(crate) mod canon;
pub(crate) mod dashboard;
pub(crate) mod documents;
pub(crate) mod history;
pub(crate) mod library;
pub(crate) mod live;
pub(crate) mod route;
pub(crate) mod schedules;

use std::rc::Rc;

use gpui::{
    AnyView, App, AppContext as _, Context, Entity, EventEmitter, IntoElement, Render,
    SharedString, Styled as _, Window, div,
};
use serde::Deserialize;
use serde_json::Value;

pub(crate) use live::{ManageLive, Topic};

use crate::ui::source::wire::{NavigationView, ProjectDashboardDocument};
use crate::ui::viewer::FileViewerEntry;

/// `LibraryKind`: a 서랍 kind; scraps and bookmarks have groups (bookmark groups are folders).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum LibraryKind {
    Scrap,
    Document,
    Bookmark,
    Output,
}

/// `LibraryView`: the main screen, a kind's full view (`section`), a group in it (`group`: an id
/// or "none" for ungrouped), a scrap's detail (`item`) and a document (`doc`).
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct LibraryView {
    pub(crate) section: Option<LibraryKind>,
    pub(crate) group: Option<SharedString>,
    pub(crate) item: Option<SharedString>,
    pub(crate) doc: Option<SharedString>,
}

/// Where the history page was opened from (its titlebar parent).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum HistoryFrom {
    Browser,
    Settings,
}

/// `AppView` without `browser` (P5) and `settings` (the settings screen overlays the frame).
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) enum View {
    #[default]
    Session,
    History {
        from: HistoryFrom,
    },
    Library(LibraryView),
    Automations,
    /// `"new"` creates (AutomationsView.tsx:59).
    AutomationDetail(SharedString),
    ProjectDashboard {
        project: SharedString,
        epic: Option<SharedString>,
    },
    PlanOverview {
        project: SharedString,
        plan: Option<SharedString>,
    },
}

/// A page callback with no value (back, close, saved).
pub(crate) type Action = Rc<dyn Fn(&mut Window, &mut App)>;
/// A page callback that takes one value (a pick, a change).
pub(crate) type Pick<T> = Rc<dyn Fn(T, &mut Window, &mut App)>;
/// What leaving runs once the leave guard lets it.
pub(crate) type Proceed = Box<dyn FnOnce(&mut Window, &mut App)>;
/// `leaveCanonEditor`: given what leaving does, it runs it now or after the owner settles the
/// unsaved inline edit.
pub(crate) type LeaveGuard = Rc<dyn Fn(Proceed, &mut Window, &mut App)>;

/// The shell's management state; pages observe it. The shell writes it, pages ask through
/// [`ManageCtx`].
#[derive(Default)]
pub(crate) struct ManageState {
    pub(crate) view: View,
    /// The store's `/navigation` view, pushed by the shell when it changes.
    pub(crate) navigation: Option<Rc<NavigationView>>,
    /// The window's composer while the dashboard shows it in its footer (D4); `None` elsewhere.
    pub(crate) composer: Option<AnyView>,
    /// `useInlineExitGuard` while an inline edit is dirty.
    pub(crate) leave_guard: Option<LeaveGuard>,
}

/// What pages ask the shell to do (the store actions they call in React).
pub(crate) enum ManageEvent {
    SetView(View),
    OpenProjectDashboard(SharedString),
    OpenSession(SharedString),
    OpenNewChat,
    OpenProjectChat(SharedString),
    StartProjectChatWithDocument {
        project: SharedString,
        document: Box<ProjectDashboardDocument>,
    },
    OpenSettings(SharedString),
    OpenObserver {
        session: SharedString,
        turn: Option<SharedString>,
    },
    OpenArtifact {
        session: SharedString,
        entry: FileViewerEntry,
    },
    SetLeftOpen(bool),
    RefreshNavigation,
    AttachLibrary {
        session: SharedString,
        reference: Rc<Value>,
    },
}

impl EventEmitter<ManageEvent> for ManageState {}

/// The window's [`ManageCtx`] for code with no page to hand it down (the file viewer's document).
struct WindowCtx(ManageCtx);

impl gpui::Global for WindowCtx {}

/// Called once by the shell at start-up.
pub(crate) fn install_window(ctx: &ManageCtx, cx: &mut App) {
    cx.set_global(WindowCtx(ctx.clone()));
}

pub(crate) fn window_ctx(cx: &App) -> Option<ManageCtx> {
    cx.try_global::<WindowCtx>().map(|window| window.0.clone())
}

/// What every page gets. Cheap to clone.
#[derive(Clone)]
pub(crate) struct ManageCtx {
    pub(crate) state: Entity<ManageState>,
    pub(crate) live: Entity<ManageLive>,
}

impl ManageCtx {
    fn emit(&self, event: ManageEvent, cx: &mut App) {
        self.state.update(cx, |_, cx| cx.emit(event));
    }

    pub(crate) fn view(&self, cx: &App) -> View {
        self.state.read(cx).view.clone()
    }

    pub(crate) fn navigation(&self, cx: &App) -> Option<Rc<NavigationView>> {
        self.state.read(cx).navigation.clone()
    }

    pub(crate) fn composer(&self, cx: &App) -> Option<AnyView> {
        self.state.read(cx).composer.clone()
    }

    /// `setView` (behind the leave guard).
    pub(crate) fn set_view(&self, view: View, cx: &mut App) {
        self.emit(ManageEvent::SetView(view), cx);
    }

    /// `openProjectDashboard` (behind the leave guard).
    pub(crate) fn open_project_dashboard(&self, project: SharedString, cx: &mut App) {
        self.emit(ManageEvent::OpenProjectDashboard(project), cx);
    }

    /// `openSession`: the conversation view on that session.
    pub(crate) fn open_session(&self, id: SharedString, cx: &mut App) {
        self.emit(ManageEvent::OpenSession(id), cx);
    }

    pub(crate) fn open_new_chat(&self, cx: &mut App) {
        self.emit(ManageEvent::OpenNewChat, cx);
    }

    /// `openNewProjectChat`
    pub(crate) fn open_project_chat(&self, project: SharedString, cx: &mut App) {
        self.emit(ManageEvent::OpenProjectChat(project), cx);
    }

    /// `startProjectChatWithDocument`: a new project chat with the document attached.
    pub(crate) fn start_project_chat_with_document(
        &self,
        project: SharedString,
        document: ProjectDashboardDocument,
        cx: &mut App,
    ) {
        self.emit(
            ManageEvent::StartProjectChatWithDocument {
                project,
                document: Box::new(document),
            },
            cx,
        );
    }

    /// `openSettings(section)` (behind the leave guard).
    pub(crate) fn open_settings(&self, section: &str, cx: &mut App) {
        self.emit(ManageEvent::OpenSettings(section.to_owned().into()), cx);
    }

    /// `openSessionObserver(session, turn)`
    pub(crate) fn open_observer(
        &self,
        session: SharedString,
        turn: Option<SharedString>,
        cx: &mut App,
    ) {
        self.emit(ManageEvent::OpenObserver { session, turn }, cx);
    }

    /// `store.openArtifact`: the file opens in the session's viewer and the conversation shows.
    pub(crate) fn open_artifact(
        &self,
        session: SharedString,
        entry: FileViewerEntry,
        cx: &mut App,
    ) {
        self.emit(ManageEvent::OpenArtifact { session, entry }, cx);
    }

    /// `setLeftOpen`
    pub(crate) fn set_left_open(&self, open: bool, cx: &mut App) {
        self.emit(ManageEvent::SetLeftOpen(open), cx);
    }

    /// `refreshNavigation`
    pub(crate) fn refresh_navigation(&self, cx: &mut App) {
        self.emit(ManageEvent::RefreshNavigation, cx);
    }

    /// `libraryStore.attachLibrary`'s reference into the session's composer (F3).
    pub(crate) fn attach_library(&self, session: SharedString, reference: Rc<Value>, cx: &mut App) {
        self.emit(ManageEvent::AttachLibrary { session, reference }, cx);
    }

    /// `useInlineExitGuard` registers while an inline edit is dirty; `None` clears it. The shell
    /// also clears it when the page that set it is dropped.
    pub(crate) fn set_leave_guard(&self, guard: Option<LeaveGuard>, cx: &mut App) {
        self.state.update(cx, |state, _| state.leave_guard = guard);
    }
}

/// React's remount keys (`AppShell.tsx` `ErrorBoundary key`): the shell rebuilds the page only
/// when this changes. `None` for the conversation.
pub(crate) fn page_key(view: &View) -> Option<SharedString> {
    let key: SharedString = match view {
        View::Session => return None,
        View::History { .. } => "history".into(),
        View::Library(_) => "library".into(),
        View::Automations => "automations".into(),
        View::AutomationDetail(_) => "automation-detail".into(),
        View::ProjectDashboard { project, .. } => project.clone(),
        View::PlanOverview { project, plan } => {
            format!("{project}:{}", plan.as_deref().unwrap_or_default()).into()
        }
    };
    Some(key)
}

/// The page of `view` (`AppWorkspaceContent`); `None` for the conversation.
pub(crate) fn page(
    view: &View,
    ctx: ManageCtx,
    window: &mut Window,
    cx: &mut App,
) -> Option<AnyView> {
    Some(match view {
        View::Session => return None,
        View::History { .. } => history::page(ctx, window, cx),
        View::Library(_) => library::page(ctx, window, cx),
        View::Automations | View::AutomationDetail(_) => schedules::page(ctx, window, cx),
        View::ProjectDashboard { .. } => dashboard::page(ctx, window, cx),
        View::PlanOverview { .. } => canon::plan::page(ctx, window, cx),
    })
}

/// An empty page: the body of every stub.
struct Placeholder;

impl Render for Placeholder {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().size_full()
    }
}

/// An empty page, the stub body.
pub(crate) fn placeholder(cx: &mut App) -> AnyView {
    cx.new(|_| Placeholder).into()
}
