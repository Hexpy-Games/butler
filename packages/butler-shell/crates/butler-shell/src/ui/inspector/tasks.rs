//! `TasksPanel`, `TaskGraphView`, `TaskNodeDetail`, `taskGraphPresentation` and `useTaskGraphClock`.
mod detail;
mod document;
mod load;
mod present;
mod view;

use std::rc::Rc;
use std::time::Duration;

use butler_ds::ui::blocks::empty_line::EmptyLine;
use butler_ds::ui::blocks::inspector_panel::InspectorInset;
use butler_ds::ui::blocks::task_graph_section::TaskGraphPanel;
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::context::{Ds, Lang};
use butler_ds::ui::icon::{IconSize, icon};
use butler_ds::ui::layout::{Space, Stack};
use butler_ds::ui::toast::{self, Toast};
use butler_ds::ui::Icon;
use gpui::{
    AnyElement, App, ElementId, Entity, Global, IntoElement as _, ParentElement as _, Window,
};

use super::InspectorCtx;
use crate::ui::i18n::task_graph::{self as copy, Words};
use crate::ui::source::agent::Jobs;
use crate::ui::source::wire::{
    AppEventEnvelope, TaskGraphDocumentWire, TaskGraphNodeWire, TaskGraphStateWire,
};
use crate::ui::store::task_graph::{TaskGraphViewState, TaskGraphs};

type SessionObserver = Rc<dyn Fn(&str, &mut App)>;

/// `openSessionObserver`: registered by the shell, which owns the observer dialog.
#[derive(Default)]
struct OpenObserver(Option<SessionObserver>);

impl Global for OpenObserver {}

/// Registers what opens a worker's conversation (`openSessionObserver`).
pub(crate) fn on_open_session_observer(cx: &mut App, handler: impl Fn(&str, &mut App) + 'static) {
    cx.default_global::<OpenObserver>().0 = Some(Rc::new(handler));
}

/// The store the shown panel reads; the shell's event feed reaches it through
/// [`receive_task_graph_event`].
struct Host(Entity<TaskGraphs>);

impl Global for Host {}

/// `receiveTaskGraphEvent`: the shell hands every live event here.
pub(crate) fn receive_task_graph_event(event: &AppEventEnvelope, cx: &mut App) {
    let Some(store) = cx.try_global::<Host>().map(|host| host.0.clone()) else {
        return;
    };
    let actions = store.update(cx, |graphs, cx| {
        cx.notify();
        graphs.receive_event(&event.r#type, &event.payload)
    });
    load::run_actions(&store, actions, cx);
}

/// What the panel's callbacks reach: the store, the open document and the session shown.
struct Actions {
    store: Entity<TaskGraphs>,
    document: Entity<Option<TaskGraphDocumentWire>>,
    session: String,
    lang: Lang,
}

impl Actions {
    /// `onSelect`
    fn select(&self, task: &str, cx: &mut App) {
        self.store.update(cx, |graphs, cx| {
            graphs.select(&self.session, task);
            cx.notify();
        });
    }

    /// `onToggle`
    fn toggle(&self, graph: &str, cx: &mut App) {
        self.store.update(cx, |graphs, cx| {
            graphs.toggle(&self.session, graph);
            cx.notify();
        });
    }

    /// `onOpenSession`
    fn open_session(&self, session: &str, cx: &mut App) {
        if let Some(open) = cx.try_global::<OpenObserver>().and_then(|o| o.0.clone()) {
            open(session, cx);
        }
    }

    /// `onOpenDocument`
    fn open_document(&self, node: &TaskGraphNodeWire, cx: &mut App) {
        let (task, revision) = (node.task_id.clone(), node.document.revision.clone());
        let read = Jobs::run(cx, move |client| async move {
            load::read_document(&client, &task, &revision).await
        });
        let (document, error) = (self.document.clone(), copy::words(self.lang).error);
        cx.spawn(async move |cx| {
            let read = read.await.flatten();
            cx.update(|cx| match read {
                Some(read) => document.update(cx, |document, cx| {
                    *document = Some(read);
                    cx.notify();
                }),
                None => {
                    toast::show(cx, Toast::error(error));
                }
            });
        })
        .detach();
    }
}

/// `useTaskGraphClock`: a graph owns one clock, and releases it as soon as its work is idle.
/// The view renders again each second while `running`.
fn task_graph_clock(id: ElementId, running: bool, window: &mut Window, cx: &mut App) -> i64 {
    struct Clock {
        pending: bool,
    }
    let clock = window.use_keyed_state(id, cx, |_, _| Clock { pending: false });
    if running && !clock.read(cx).pending {
        clock.update(cx, |clock, _| clock.pending = true);
        let clock = clock.downgrade();
        window
            .spawn(cx, async move |cx| {
                cx.background_executor().timer(Duration::from_secs(1)).await;
                cx.update(|_, cx| {
                    clock
                        .update(cx, |clock, cx| {
                            clock.pending = false;
                            cx.notify();
                        })
                        .ok();
                })
                .ok();
            })
            .detach();
    }
    present::now_ms()
}

/// `TasksPanel hideHeading`: the host (a dialog) already titles the view, so the panel's own
/// heading is omitted.
pub(crate) fn tasks_panel_in_dialog(
    ctx: &InspectorCtx<'_>,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    session_tasks_panel(&ctx.view.session_id, true, window, cx)
}

/// `SessionTasksPanel`. The session hint (`runtimeId`) is not on the view, so the session id
/// stands for it.
fn session_tasks_panel(
    session: &str,
    hide_heading: bool,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let store = window.use_keyed_state("task-graphs", cx, |_, _| TaskGraphs::default());
    let document = window.use_keyed_state("task-graphs-document", cx, |_, _| None::<TaskGraphDocumentWire>);
    if cx.try_global::<Host>().is_none_or(|host| host.0 != store) {
        cx.set_global(Host(store.clone()));
    }
    if store.update(cx, |graphs, _| graphs.observe(session, session)) {
        load::load_task_graphs(&store, session, cx);
    }
    let lang = Ds::get(cx).lang();
    let words = copy::words(lang);
    let state = store.read(cx).view(session).unwrap_or_default();
    let actions = Rc::new(Actions {
        store: store.clone(),
        document: document.clone(),
        session: session.to_owned(),
        lang,
    });
    let single = state.graphs.len() == 1;
    let sections: Vec<AnyElement> = state
        .graphs
        .iter()
        .map(|graph| {
            let open = state.open.get(&graph.summary.graph_id).copied().unwrap_or(false);
            let selected = state.selected.as_deref();
            view::task_graph_view(graph, selected, open, single, &actions, window, cx)
        })
        .collect();
    let body = if hide_heading && state.graphs.is_empty() {
        InspectorInset::new()
            .child(EmptyLine::new(empty_label(&state, words)))
            .into_any_element()
    } else if hide_heading {
        Stack::new().gap(Space::Xs).children(sections).into_any_element()
    } else {
        graph_panel(&state, words, lang, sections, cx)
    };
    let retry = state.error.then(|| retry_button(session, &store, words));
    let dialog = document::document_dialog(&document, words, window, cx);
    Stack::new()
        .gap(Space::None)
        .child(body)
        .children(retry)
        .child(dialog)
        .into_any_element()
}

fn empty_label(state: &TaskGraphViewState, words: &Words) -> &'static str {
    if state.loading {
        words.loading
    } else if state.error {
        words.error
    } else {
        words.empty
    }
}

/// The `TaskGraphPanel` with the heading, its summary and the graph sections.
fn graph_panel(
    state: &TaskGraphViewState,
    words: &Words,
    lang: Lang,
    sections: Vec<AnyElement>,
    cx: &App,
) -> AnyElement {
    let ds = Ds::get(cx);
    let single = (state.graphs.len() == 1).then(|| &state.graphs[0]);
    let mut panel = TaskGraphPanel::new(words.title, empty_label(state, words))
        .icon(icon(Icon::Blocks, IconSize::Md, ds))
        .empty(state.graphs.is_empty());
    if let Some(graph) = single {
        panel = panel
            .description(graph.summary.title.clone())
            .header_meta(present::graph_meta(lang, words, graph));
    } else if !state.graphs.is_empty() {
        let running = state
            .graphs
            .iter()
            .filter(|g| g.summary.state == TaskGraphStateWire::Running)
            .count();
        panel = panel.header_meta(copy::graphs_summary(lang, state.graphs.len(), running));
    }
    panel.children(sections).into_any_element()
}

/// The retry button under a failed load: `loadTaskGraphs(sessionId)`.
fn retry_button(session: &str, store: &Entity<TaskGraphs>, words: &Words) -> AnyElement {
    let (session, store) = (session.to_owned(), store.clone());
    let button = Button::new("task-graphs-retry")
        .size(Size::Sm)
        .variant(Variant::Outline)
        .text(words.retry)
        .on_click(move |_, _, cx| load::load_task_graphs(&store, &session, cx));
    InspectorInset::new().child(button).into_any_element()
}
