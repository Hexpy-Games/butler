//! TaskGraphCanvas.showcase.tsx: each demo graph left to right with its selection, the fan-out
//! graph on a phone (lanes), and the plain renderNode canvas. The React `widths` (app, wide,
//! 375) are the canvas widths the harness forces, not separate stories.
pub(super) mod parts;

use butler_ds::ui::blocks::task_graph_canvas::{Orientation, TaskGraphCanvas};
use gpui::{AnyElement, App, IntoElement as _, Window};

use self::parts::{graph_view, plain_view};
use super::Story;
use super::task_graph_card::data::GraphId;
use crate::copy::Lang;

const SCOPE: &str = "tgc";

fn left_to_right(id: GraphId, lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    graph_view(
        (SCOPE, id, Orientation::Horizontal),
        false,
        lang,
        window,
        cx,
    )
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "One task · left to right",
            render: |lang, window, cx| left_to_right(GraphId::One, lang, window, cx),
        },
        Story {
            name: "Chain · left to right",
            render: |lang, window, cx| left_to_right(GraphId::Chain, lang, window, cx),
        },
        Story {
            name: "Fan-out and join · left to right",
            render: |lang, window, cx| left_to_right(GraphId::Fanout, lang, window, cx),
        },
        Story {
            name: "Failed task (blocked join) · left to right",
            render: |lang, window, cx| left_to_right(GraphId::Failed, lang, window, cx),
        },
        Story {
            name: "Cancelled · left to right",
            render: |lang, window, cx| left_to_right(GraphId::Cancelled, lang, window, cx),
        },
        Story {
            name: "Rank-skipping edge (dummy slot) · left to right",
            render: |lang, window, cx| left_to_right(GraphId::Skip, lang, window, cx),
        },
        Story {
            name: "Long graph (16 tasks) · left to right",
            render: |lang, window, cx| left_to_right(GraphId::Long, lang, window, cx),
        },
        Story {
            name: "Fan-out and join · phone (auto switches to lanes)",
            render: phone,
        },
        Story {
            name: "Plain renderNode (no selection)",
            render: plain,
        },
    ]
}

fn phone(lang: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    graph_view(
        (SCOPE, GraphId::Fanout, Orientation::Vertical),
        false,
        lang,
        window,
        cx,
    )
}

fn plain(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    TaskGraphCanvas::new(plain_view("tgc-plain", GraphId::Chain, lang))
        .orientation(Orientation::Horizontal)
        .into_any_element()
}
