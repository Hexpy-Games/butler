//! TaskGraphCanvas.showcaseParts.tsx: the story compositions the task graph showcases share,
//! the same wiring the product container does (copy, a card per node, the detail of a task).
use butler_ds::ui::blocks::notice::NoticeTone;
use butler_ds::ui::blocks::task_graph_card::{TaskGraphCard, TaskGraphStatus, TaskGraphStepLine};
use butler_ds::ui::blocks::task_graph_detail::{
    DetailConversation, DetailDocument, RelatedTask, TaskGraphDetail, TaskGraphDetailFact,
    TaskGraphDetailRelation,
};
use gpui::SharedString;
use std::rc::Rc;

use super::data::{DemoGraph, DemoTask};
use crate::copy::Lang;

/// The localized words of the demo (`COPY`).
pub(crate) struct DemoCopy {
    pub(crate) worker_prefix: &'static str,
    pub(crate) unassigned: &'static str,
    pub(crate) panel: &'static str,
    pub(crate) empty: &'static str,
    done_suffix: &'static str,
    assignee: &'static str,
    model: &'static str,
    time: &'static str,
    now: &'static str,
    after: &'static str,
    next: &'static str,
    none: &'static str,
    doc: &'static str,
    open: &'static str,
    talk: &'static str,
    blocked: &'static str,
}

pub(crate) fn demo_copy(lang: Lang) -> DemoCopy {
    lang.pick(
        DemoCopy {
            worker_prefix: "Worker ",
            unassigned: "Not assigned",
            panel: "Task graph",
            empty: "No tasks yet",
            done_suffix: " done",
            assignee: "Assignee",
            model: "Model",
            time: "Time",
            now: "Now",
            after: "After",
            next: "Next",
            none: "None",
            doc: "Task document",
            open: "Open",
            talk: "View conversation",
            blocked: "An earlier task failed",
        },
        DemoCopy {
            worker_prefix: "작업자 ",
            unassigned: "배정 전",
            panel: "작업 그래프",
            empty: "아직 작업이 없습니다",
            done_suffix: " 완료",
            assignee: "담당",
            model: "모델",
            time: "걸린 시간",
            now: "지금 하는 일",
            after: "앞선 작업",
            next: "다음 작업",
            none: "없음",
            doc: "작업 문서",
            open: "열기",
            talk: "대화 보기",
            blocked: "앞선 작업이 실패했습니다",
        },
    )
}

/// `STATUS`: the localized status word.
pub(crate) fn status_label(lang: Lang, status: TaskGraphStatus) -> &'static str {
    use TaskGraphStatus as S;
    let (en, ko) = match status {
        S::Pending => ("Waiting", "대기"),
        S::Running => ("Running", "진행 중"),
        S::Review => ("In review", "검토 중"),
        S::Done => ("Done", "완료"),
        S::Failed => ("Failed", "실패"),
        S::Blocked => ("Blocked", "보류"),
        S::Cancelled => ("Cancelled", "취소됨"),
        S::Paused => ("Paused", "일시정지"),
    };
    lang.pick(en, ko)
}

/// `Worker 3`.
pub(crate) fn worker_label(lang: Lang, worker: u8) -> String {
    format!("{}{worker}", demo_copy(lang).worker_prefix)
}

/// `graphs(n, r)`: "3 graphs · 1 running".
pub(crate) fn graphs_count(lang: Lang, graphs: usize, running: usize) -> String {
    match (lang, running) {
        (Lang::En, 0) => format!("{graphs} graphs"),
        (Lang::En, _) => format!("{graphs} graphs · {running} running"),
        (Lang::Ko, 0) => format!("그래프 {graphs}개"),
        (Lang::Ko, _) => format!("그래프 {graphs}개 · 진행 중 {running}"),
    }
}

/// Demo times are written "2m 05s"; Korean stories read "2분 05초".
pub(crate) fn local_time(time: &str, lang: Lang) -> String {
    match lang {
        Lang::En => time.to_owned(),
        Lang::Ko => time.replace('m', "분").replace('s', "초"),
    }
}

/// `demoCounts`: "2/6 done".
pub(crate) fn demo_counts(graph: &DemoGraph, lang: Lang) -> String {
    let done = graph
        .tasks
        .iter()
        .filter(|task| task.status == TaskGraphStatus::Done)
        .count();
    format!(
        "{done}/{}{}",
        graph.tasks.len(),
        demo_copy(lang).done_suffix
    )
}

fn meta_of(task: &DemoTask, lang: Lang) -> String {
    match (task.worker, task.model) {
        (Some(worker), Some(model)) => format!("{} · {model}", worker_label(lang, worker)),
        _ => demo_copy(lang).unassigned.to_owned(),
    }
}

/// `DemoCard`: a TaskGraphCard for one demo task. Chain `.selected(..)` and `.on_activate(..)`.
pub(crate) fn demo_card(task: &DemoTask, lang: Lang) -> TaskGraphCard {
    let mut card = TaskGraphCard::new(
        task.id,
        task.title.get(lang),
        task.status,
        status_label(lang, task.status),
    )
    .meta(meta_of(task, lang));
    if let Some(time) = &task.time {
        card = card.time(local_time(time, lang));
    }
    if let Some(step) = task.step {
        card = card.step(step.get(lang));
    }
    card
}

fn facts(task: &DemoTask, lang: Lang) -> Vec<TaskGraphDetailFact> {
    let c = demo_copy(lang);
    let assignee = task.worker.map_or_else(
        || c.unassigned.to_owned(),
        |worker| worker_label(lang, worker),
    );
    let mut facts = vec![TaskGraphDetailFact::text("assignee", c.assignee, assignee)];
    if let Some(model) = task.model {
        facts.push(TaskGraphDetailFact::text("model", c.model, model));
    }
    if let Some(time) = &task.time {
        facts.push(TaskGraphDetailFact::text(
            "time",
            c.time,
            local_time(time, lang),
        ));
    }
    if let (TaskGraphStatus::Running, Some(step)) = (task.status, task.step) {
        let line = TaskGraphStepLine::new(format!("{}-detail-step", task.id), step.get(lang));
        facts.push(TaskGraphDetailFact::element("now", c.now, line));
    }
    facts
}

fn related(
    graph: &DemoGraph,
    ids: impl Iterator<Item = &'static str>,
    lang: Lang,
) -> Vec<RelatedTask> {
    ids.filter_map(|id| graph.task(id))
        .map(|task| RelatedTask {
            id: SharedString::from(task.id),
            title: SharedString::from(task.title.get(lang)),
        })
        .collect()
}

fn relations(graph: &DemoGraph, task: &DemoTask, lang: Lang) -> Vec<TaskGraphDetailRelation> {
    let c = demo_copy(lang);
    let before = graph
        .edges
        .iter()
        .filter(|edge| edge.1 == task.id)
        .map(|edge| edge.0);
    let after = graph
        .edges
        .iter()
        .filter(|edge| edge.0 == task.id)
        .map(|edge| edge.1);
    vec![
        TaskGraphDetailRelation {
            id: "after".into(),
            label: c.after.into(),
            empty_label: c.none.into(),
            tasks: related(graph, before, lang),
        },
        TaskGraphDetailRelation {
            id: "next".into(),
            label: c.next.into(),
            empty_label: c.none.into(),
            tasks: related(graph, after, lang),
        },
    ]
}

/// `DemoDetail`: TaskGraphDetail for one demo task (facts, links, document tile, conversation).
/// Chain `.on_select_task(..)` to wire the links.
pub(crate) fn demo_detail(graph: &DemoGraph, task: &DemoTask, lang: Lang) -> TaskGraphDetail {
    let c = demo_copy(lang);
    let label = status_label(lang, task.status);
    let mut detail = TaskGraphDetail::new(
        format!("detail-{}", task.id),
        task.title.get(lang),
        task.status,
        label,
    )
    .facts(facts(task, lang))
    .relations(relations(graph, task, lang))
    .document(DetailDocument {
        title: c.doc.into(),
        meta: Some(format!("TASK-{} · {label}", task.id.to_uppercase()).into()),
        action_label: Some(c.open.into()),
        on_open: Rc::new(|_, _| {}),
    });
    if let Some(reason) = task.reason {
        detail = detail.notice(NoticeTone::Error, reason.get(lang));
    } else if task.status == TaskGraphStatus::Blocked {
        detail = detail.notice(NoticeTone::Warning, c.blocked);
    }
    if task.worker.is_some() {
        detail = detail.conversation(DetailConversation {
            label: c.talk.into(),
            on_open: Rc::new(|_, _| {}),
        });
    }
    detail
}
