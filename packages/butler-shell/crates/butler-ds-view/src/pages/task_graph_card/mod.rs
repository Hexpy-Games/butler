//! TaskGraphCard.showcase.tsx: every status, a running card with its live step (also
//! selected), a two-line title on an unassigned task, and the status glyphs with the step line.
//! `data` and `demo` are the shared showcase data and compositions (TaskGraphCanvas.showcaseData
//! / showcaseParts) the other task graph pages build on.
pub(super) mod data;
pub(super) mod demo;

use butler_ds::ui::blocks::task_graph_card::{
    TaskGraphCard, TaskGraphStatus, TaskGraphStatusIcon, TaskGraphStepLine,
};
use butler_ds::ui::layout::{Columns, Grid, Space, Stack};
use butler_ds::ui::typo::{Tone, Typo};
use gpui::{AnyElement, App, IntoElement as _, Window};

use self::data::{DemoTask, GraphId};
use self::demo::{demo_card, status_label};
use super::Story;
use crate::copy::Lang;

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Every status",
            render: every_status,
        },
        Story {
            name: "Running with a live step, selected",
            render: running_selected,
        },
        Story {
            name: "Long title (two lines) and unassigned",
            render: long_title,
        },
        Story {
            name: "Status glyphs and step line",
            render: glyphs,
        },
    ]
}

/// `GRAPHS.fanout` task `r2`: the running task the stories use.
fn running_graph() -> data::DemoGraph {
    GraphId::Fanout.build()
}

fn every_status(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let graph = running_graph();
    let Some(task) = graph.task("r2") else {
        return Stack::new().into_any_element();
    };
    Grid::new("tgc-every-status")
        .columns(Columns::AUTO_FIT)
        .gap(Space::Md)
        .children(TaskGraphStatus::ALL.iter().map(|&status| card_for(task, status, lang)))
        .into_any_element()
}

/// The "Every status" card: the running task's title, model, time and step in `status`.
fn card_for(task: &DemoTask, status: TaskGraphStatus, lang: Lang) -> TaskGraphCard {
    let mut card = TaskGraphCard::new(
        format!("tgc-{status:?}"),
        task.title.get(lang),
        status,
        status_label(lang, status),
    );
    if status != TaskGraphStatus::Pending {
        if let Some(model) = task.model {
            card = card.meta(model);
        }
        if let Some(time) = &task.time {
            card = card.time(time.clone());
        }
    }
    if let Some(step) = task.step {
        card = card.step(step.get(lang));
    }
    card
}

fn running_selected(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let graph = running_graph();
    let Some(task) = graph.task("r2") else {
        return Stack::new().into_any_element();
    };
    Stack::new()
        .gap(Space::Md)
        .child(demo_card(task, lang))
        .child(demo_card(task, lang).selected(true))
        .into_any_element()
}

fn long_title(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    TaskGraphCard::new(
        "tgc-long",
        lang.pick(
            "Match the result ordering to the user's settings and compare it with the previous history",
            "결과 화면의 정렬 기준을 사용자 설정에 맞추고 이전 기록과 비교하기",
        ),
        TaskGraphStatus::Pending,
        status_label(lang, TaskGraphStatus::Pending),
    )
    .into_any_element()
}

fn glyphs(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let graph = running_graph();
    let step = graph
        .task("r2")
        .and_then(|task| task.step)
        .map_or("", |step| step.get(lang));
    let icons = Stack::row().gap(Space::Md).children(
        TaskGraphStatus::ALL
            .iter()
            .map(|&status| TaskGraphStatusIcon::new(format!("tgc-glyph-{status:?}"), status)),
    );
    Stack::new()
        .gap(Space::Sm)
        .child(icons)
        .child(TaskGraphStepLine::new("tgc-step", step))
        .child(
            Typo::caption(status_label(lang, TaskGraphStatus::Running)).tone(Tone::Tertiary),
        )
        .into_any_element()
}
