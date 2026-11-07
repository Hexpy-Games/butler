//! TaskGraphLanes.showcase.tsx: each demo graph as lanes (the phone layout), and the lanes block
//! alone. The React `widths` (320, 375, 430) are the canvas widths the harness forces.
use butler_ds::ui::blocks::task_graph_canvas::Orientation;
use butler_ds::ui::blocks::task_graph_lanes::TaskGraphLanes;
use gpui::{AnyElement, App, IntoElement as _, Window};

use super::Story;
use super::task_graph_canvas::parts::{graph_view, plain_view};
use super::task_graph_card::data::GraphId;
use crate::copy::Lang;

const SCOPE: &str = "tgl";

fn lanes(id: GraphId, lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    graph_view((SCOPE, id, Orientation::Vertical), false, lang, window, cx)
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Chain",
            render: |lang, window, cx| lanes(GraphId::Chain, lang, window, cx),
        },
        Story {
            name: "Fan-out and join",
            render: |lang, window, cx| lanes(GraphId::Fanout, lang, window, cx),
        },
        Story {
            name: "Failed task",
            render: |lang, window, cx| lanes(GraphId::Failed, lang, window, cx),
        },
        Story {
            name: "Cancelled",
            render: |lang, window, cx| lanes(GraphId::Cancelled, lang, window, cx),
        },
        Story {
            name: "Rank-skipping edge",
            render: |lang, window, cx| lanes(GraphId::Skip, lang, window, cx),
        },
        Story {
            name: "Long graph (16 tasks)",
            render: |lang, window, cx| lanes(GraphId::Long, lang, window, cx),
        },
        Story {
            name: "Lanes block alone",
            render: alone,
        },
    ]
}

fn alone(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    TaskGraphLanes::new(plain_view("tgl-alone", GraphId::Fanout, lang)).into_any_element()
}
