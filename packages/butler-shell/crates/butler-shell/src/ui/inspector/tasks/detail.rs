//! `TaskNodeDetail`: the selected task of a graph, read-only.
use std::rc::Rc;

use butler_ds::ui::blocks::notice::NoticeTone;
use butler_ds::ui::blocks::task_graph_card::{TaskGraphStatus, TaskGraphStepLine};
use butler_ds::ui::blocks::task_graph_detail::{
    DetailConversation, DetailDocument, RelatedTask, TaskGraphDetail, TaskGraphDetailFact,
    TaskGraphDetailRelation,
};
use gpui::{ElementId, SharedString};

use super::Actions;
use super::present::{graph_assignee, graph_elapsed, graph_status_label, graph_task_status};
use crate::ui::i18n::task_graph::{self as copy, Words};
use crate::ui::source::wire::{TaskGraphNodeWire, TaskGraphReasonWire, TaskGraphSnapshotWire};

/// `related`: the tasks on the other end of the edges that touch `node` (before it, or after).
fn related(
    graph: &TaskGraphSnapshotWire,
    node: &TaskGraphNodeWire,
    before: bool,
) -> Vec<RelatedTask> {
    graph
        .edges
        .iter()
        .filter(|e| (if before { &e.to } else { &e.from }) == &node.task_id)
        .filter_map(|e| {
            let other = if before { &e.from } else { &e.to };
            graph.nodes.iter().find(|n| &n.task_id == other)
        })
        .map(|n| RelatedTask {
            id: n.task_id.clone().into(),
            title: n.title.clone().into(),
        })
        .collect()
}

/// The failure reason or the blocked explanation, if any.
fn notice(node: &TaskGraphNodeWire, words: &Words) -> Option<(NoticeTone, SharedString)> {
    match node.reason_code {
        Some(TaskGraphReasonWire::ReviewRevised) => {
            Some((NoticeTone::Warning, words.review_notice.into()))
        }
        Some(TaskGraphReasonWire::ResultReceived) => {
            Some((NoticeTone::Warning, words.result_received.into()))
        }
        Some(code @ (TaskGraphReasonWire::ActionBlocked | TaskGraphReasonWire::AttemptFailed)) => {
            let reason = node.blocked_reason.as_ref().filter(|r| !r.is_empty())?;
            let tone = if code == TaskGraphReasonWire::AttemptFailed {
                NoticeTone::Error
            } else {
                NoticeTone::Warning
            };
            Some((tone, reason.clone().into()))
        }
        _ => None,
    }
}

fn facts(
    node: &TaskGraphNodeWire,
    status: TaskGraphStatus,
    now: i64,
    actions: &Actions,
) -> Vec<TaskGraphDetailFact> {
    let (lang, id) = (actions.lang, &node.task_id);
    let words = copy::words(lang);
    let mut facts = vec![TaskGraphDetailFact::text(
        "assignee",
        words.assignee_label,
        graph_assignee(lang, words, node),
    )];
    if !node.attempts.is_empty() {
        facts.push(TaskGraphDetailFact::text(
            "attempts",
            words.attempts_label,
            copy::attempts(lang, node.attempts.len()),
        ));
    }
    let earlier = node.attempts.len().saturating_sub(1);
    for (index, attempt) in node.attempts.iter().take(earlier).enumerate() {
        facts.push(TaskGraphDetailFact::text(
            attempt.task_id.clone(),
            copy::attempts(lang, index + 1),
            attempt
                .summary
                .clone()
                .unwrap_or_else(|| words.none.to_owned()),
        ));
    }
    facts.push(TaskGraphDetailFact::text(
        "model",
        words.model,
        node.model_display_name
            .clone()
            .unwrap_or_else(|| words.none.to_owned()),
    ));
    facts.push(TaskGraphDetailFact::text(
        "elapsed",
        words.elapsed_label,
        graph_elapsed(lang, node, now).unwrap_or_else(|| words.none.to_owned()),
    ));
    if let (TaskGraphStatus::Running, Some(step)) = (status, &node.current_step) {
        facts.push(TaskGraphDetailFact::element(
            "step",
            words.step,
            TaskGraphStepLine::new(format!("{id}-detail-step"), step.clone()),
        ));
    }
    facts
}

/// `TaskNodeDetail`
pub(super) fn task_node_detail(
    node: &TaskGraphNodeWire,
    graph: &TaskGraphSnapshotWire,
    now: i64,
    actions: &Rc<Actions>,
) -> TaskGraphDetail {
    let words = copy::words(actions.lang);
    let status = graph_task_status(node);
    let label = graph_status_label(words, node);
    let mut detail = TaskGraphDetail::new(
        ElementId::from(format!("task-detail-{}", node.task_id)),
        node.title.clone(),
        status,
        label,
    )
    .facts(facts(node, status, now, actions))
    .relations(vec![
        TaskGraphDetailRelation {
            id: "after".into(),
            label: words.after.into(),
            tasks: related(graph, node, true),
            empty_label: words.none.into(),
        },
        TaskGraphDetailRelation {
            id: "next".into(),
            label: words.next.into(),
            tasks: related(graph, node, false),
            empty_label: words.none.into(),
        },
    ])
    .on_select_task({
        let actions = actions.clone();
        move |id, _, cx| actions.select(id, cx)
    });
    if let Some((tone, message)) = notice(node, words) {
        detail = detail.notice(tone, message);
    }
    let meta = if node.document.id.starts_with("TASK-") {
        format!("{} · {label}", node.document.id)
    } else {
        label.to_owned()
    };
    detail = detail.document(DetailDocument {
        title: node.document.title.clone().into(),
        meta: Some(meta.into()),
        action_label: Some(words.open_document.into()),
        on_open: {
            let (actions, node) = (actions.clone(), node.clone());
            Rc::new(move |_, cx| actions.open_document(&node, cx))
        },
    });
    if let Some(session) = &node.session_id {
        let session = session.clone();
        detail = detail.conversation(DetailConversation {
            label: words.conversation.into(),
            on_open: Rc::new(move |_, cx| super::Actions::open_session(&session, cx)),
        });
    }
    detail
}
