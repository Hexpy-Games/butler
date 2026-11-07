//! TaskGraphSection.showcase.tsx: the Tasks tab body empty, with one graph (no row), two graphs
//! (the running one open, the finished one folded), six graphs, and folded rows only. The React
//! `widths` (375, app) are the canvas widths the harness forces.
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::task_graph_canvas::Orientation;
use butler_ds::ui::blocks::task_graph_card::TaskGraphStatus;
use butler_ds::ui::blocks::task_graph_section::{TaskGraphPanel, TaskGraphSection};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window};

use super::Story;
use super::task_graph_canvas::parts::panel;
use super::task_graph_card::data::GraphId;
use crate::copy::Lang;

fn graphs(ids: &[GraphId], lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    panel(ids, Orientation::Auto, lang, window, cx)
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Empty",
            render: |lang, window, cx| graphs(&[], lang, window, cx),
        },
        Story {
            name: "One graph (no row)",
            render: |lang, window, cx| graphs(&[GraphId::Fanout], lang, window, cx),
        },
        Story {
            name: "Two graphs (running open, finished folded)",
            render: |lang, window, cx| {
                graphs(&[GraphId::Fanout, GraphId::ChainDone], lang, window, cx)
            },
        },
        Story {
            name: "Six graphs (running and failed open)",
            render: |lang, window, cx| {
                let ids = [
                    GraphId::ChainDone,
                    GraphId::Long,
                    GraphId::Failed,
                    GraphId::Fanout,
                    GraphId::Cancelled,
                    GraphId::One,
                ];
                graphs(&ids, lang, window, cx)
            },
        },
        Story {
            name: "Folded rows only",
            render: folded,
        },
    ]
}

fn folded(lang: Lang, _: &mut Window, cx: &mut App) -> AnyElement {
    let title = lang.pick("Task graph", "작업 그래프");
    let mut panel = TaskGraphPanel::new(title, "")
        .icon(icon(Icon::Blocks, IconSize::Md, Ds::get(cx)))
        .header_meta(lang.pick("2 graphs", "그래프 2개"));
    for (id, status) in [
        (GraphId::ChainDone, TaskGraphStatus::Done),
        (GraphId::Cancelled, TaskGraphStatus::Cancelled),
    ] {
        let graph = id.build();
        let done = graph
            .tasks
            .iter()
            .filter(|task| task.status == TaskGraphStatus::Done)
            .count();
        panel = panel.child(
            TaskGraphSection::new(graph.id, graph.title.get(lang), status)
                .meta(format!("{done}/{}", graph.tasks.len()))
                .on_toggle(|_, _| {}),
        );
    }
    panel.into_any_element()
}
