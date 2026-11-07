//! TaskGraphDetail.showcase.tsx: the detail of a running, failed, blocked and unassigned task,
//! and a minimal one.
use butler_ds::ui::blocks::task_graph_card::TaskGraphStatus;
use butler_ds::ui::blocks::task_graph_detail::{TaskGraphDetail, TaskGraphDetailFact};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window, div};

use super::Story;
use super::task_graph_card::data::{DemoGraph, GraphId};
use super::task_graph_card::demo::{demo_detail, status_label};
use crate::copy::Lang;

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Running (live step, conversation)",
            render: |lang, _, _| pick(GraphId::Fanout, "r2", lang),
        },
        Story {
            name: "Failed (reason notice)",
            render: |lang, _, _| pick(GraphId::Failed, "r2", lang),
        },
        Story {
            name: "Blocked by a failure",
            render: |lang, _, _| pick(GraphId::Failed, "compare", lang),
        },
        Story {
            name: "Waiting, not assigned (no conversation)",
            render: |lang, _, _| pick(GraphId::Fanout, "review", lang),
        },
        Story {
            name: "Minimal",
            render: minimal,
        },
    ]
}

fn pick(id: GraphId, task: &str, lang: Lang) -> AnyElement {
    let graph: DemoGraph = id.build();
    match graph.task(task) {
        Some(task) => demo_detail(&graph, task, lang).into_any_element(),
        None => div().into_any_element(),
    }
}

fn minimal(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let graph = GraphId::One.build();
    let title = graph.tasks.first().map_or("", |task| task.title.get(lang));
    let label = status_label(lang, TaskGraphStatus::Done);
    TaskGraphDetail::new("detail-minimal", title, TaskGraphStatus::Done, label)
        .facts(vec![TaskGraphDetailFact::text(
            "time",
            lang.pick("Time", "걸린 시간"),
            "1m 36s",
        )])
        .into_any_element()
}
