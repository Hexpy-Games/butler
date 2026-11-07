//! `app/taskGraphApi.ts` and the loads of `app/taskGraphState.ts`: the routes run on the agent
//! worker, their results go into the [`TaskGraphs`] store on the UI thread.
use butler_shell_client::ShellClient;
use futures::future::join_all;
use gpui::{App, AsyncApp, Entity};
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::ui::source::agent::Jobs;
use crate::ui::source::wire::{
    TaskGraphDocumentWire, TaskGraphSnapshotWire, TaskGraphSummaryWire, TaskGraphsPageWire,
};
use crate::ui::store::task_graph::{TaskGraphAction, TaskGraphs};

fn parse<T: DeserializeOwned>(value: Result<Value, butler_shell_client::Error>) -> Option<T> {
    serde_json::from_value(value.ok()?).ok()
}

/// `getSessionTaskGraphs` over every page; none when the list is incomplete.
async fn read_summaries(client: &ShellClient, session: &str) -> Option<Vec<TaskGraphSummaryWire>> {
    let first: TaskGraphsPageWire = parse(
        client
            .get_session_task_graphs(session, None, None, None)
            .await,
    )?;
    let mut graphs = first.graphs;
    let mut cursor = first.cursor;
    while let Some(next) = cursor {
        let page: TaskGraphsPageWire = parse(
            client
                .get_session_task_graphs(session, Some(&first.graph_revision), Some(&next), None)
                .await,
        )?;
        graphs.extend(page.graphs);
        cursor = page.cursor;
    }
    (u64::try_from(graphs.len()).ok()? == first.total).then_some(graphs)
}

/// `readGraph`: every node page of one graph revision; none when it is incomplete.
async fn read_graph(client: &ShellClient, graph: &str) -> Option<TaskGraphSnapshotWire> {
    let mut first: TaskGraphSnapshotWire =
        parse(client.get_plan_task_graph(graph, None, None, None).await)?;
    let mut cursor = first.cursor.take();
    while let Some(next) = cursor {
        let page: TaskGraphSnapshotWire = parse(
            client
                .get_plan_task_graph(
                    graph,
                    Some(&first.summary.graph_revision),
                    Some(&next),
                    None,
                )
                .await,
        )?;
        first.nodes.extend(page.nodes);
        cursor = page.cursor;
    }
    let complete = u64::try_from(first.nodes.len()).ok()? == first.totals.nodes
        && u64::try_from(first.edges.len()).ok()? == first.totals.edges;
    complete.then_some(first)
}

/// `getTaskDocument`
pub(super) async fn read_document(
    client: &ShellClient,
    task: &str,
    revision: &str,
) -> Option<TaskGraphDocumentWire> {
    parse(
        client
            .get_task_document(task, Some(revision), None, None)
            .await,
    )
}

/// `refreshGraph`: a result of a superseded read is dropped by the store.
async fn refresh_graph(
    store: Entity<TaskGraphs>,
    session: String,
    graph: String,
    mut cx: AsyncApp,
) {
    let generation = store.update(&mut cx, |graphs, _| graphs.begin_refresh(&session, &graph));
    let id = graph.clone();
    let read = cx.update(|cx| {
        Jobs::run(
            cx,
            move |client| async move { read_graph(&client, &id).await },
        )
    });
    let read = read.await.flatten();
    store.update(&mut cx, |graphs, cx| {
        graphs.finish_refresh(&session, &graph, generation, read);
        cx.notify();
    });
}

/// `loadTaskGraphs`: the summaries, then the graphs whose revision changed, then the
/// selection. A load already in flight is not started twice.
pub(super) fn load_task_graphs(store: &Entity<TaskGraphs>, session: &str, cx: &mut App) {
    let Some(start) = store.update(cx, |graphs, cx| {
        cx.notify();
        graphs.begin_load(session)
    }) else {
        return;
    };
    let id = session.to_owned();
    let summaries = {
        let id = id.clone();
        Jobs::run(cx, move |client| async move {
            read_summaries(&client, &id).await
        })
    };
    let store = store.clone();
    cx.spawn(async move |cx| {
        match summaries.await.flatten() {
            Some(list) => {
                let stale = store.update(cx, |graphs, _| graphs.apply_summaries(&id, &start, list));
                join_all(
                    stale
                        .into_iter()
                        .map(|graph| refresh_graph(store.clone(), id.clone(), graph, cx.clone())),
                )
                .await;
                store.update(cx, |graphs, _| graphs.finish_load(&id, &start));
            }
            None => store.update(cx, |graphs, _| graphs.load_failed(&id)),
        }
        let again = store.update(cx, |graphs, cx| {
            cx.notify();
            graphs.end_load(&id)
        });
        if again {
            cx.update(|cx| load_task_graphs(&store, &id, cx));
        }
    })
    .detach();
}

/// Runs what a live event asked for.
pub(super) fn run_actions(store: &Entity<TaskGraphs>, actions: Vec<TaskGraphAction>, cx: &mut App) {
    for action in actions {
        match action {
            TaskGraphAction::Load(session) => load_task_graphs(store, &session, cx),
            TaskGraphAction::Refresh { session, plan } => {
                let store = store.clone();
                cx.spawn(async move |cx| {
                    refresh_graph(store.clone(), session.clone(), plan, cx.clone()).await;
                    store.update(cx, |graphs, cx| {
                        graphs.reconcile_selection(&session);
                        cx.notify();
                    });
                })
                .detach();
            }
        }
    }
}
