//! The Task ownership and confirmed-input lines in a Worker packet.
use crate::btcc::{TaskInputUse, WorkTask};
pub(super) fn render_context(packet: &crate::btcc::SubsessionPacket, tasks: &[WorkTask]) -> String {
    let Some(task) = &packet.task else {
        return String::new();
    };
    let Some(scope) = &task.scope else {
        return String::new();
    };
    let owned = render_owned(scope);
    let others = tasks
        .iter()
        .filter(|t| t.task_id != packet.task_id && matches!(t.status.as_str(), "active" | "done"))
        .map(|t| {
            format!(
                "Task {} ({}): {}",
                t.task_id,
                t.status,
                render_owned(&t.scope)
            )
        });
    let excluded = scope
        .excludes
        .iter()
        .cloned()
        .chain(others)
        .collect::<Vec<_>>()
        .join("; ");
    let inputs = task
        .inputs
        .iter()
        .filter_map(|i| tasks.iter().find(|t| t.task_id == i.task).map(|t| (i, t)))
        .map(|(input, t)| {
            format!(
                "{} evidence:{} — {}{}",
                t.task_id,
                t.result_ref.as_deref().unwrap_or(""),
                t.summary
                    .as_deref()
                    .unwrap_or("")
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" "),
                input_use(input)
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "\ntask: {} (action {})\nowns: {owned}\ndo_not_touch: {excluded}\ninputs (confirmed, do not re-check): {inputs}\nreturn: {}",
        packet.task_id,
        packet
            .plan_action
            .as_ref()
            .map(|a| a.action_key.as_str())
            .unwrap_or(""),
        serde_json::to_string(&task.output).unwrap_or_default()
    )
}

fn input_use(input: &crate::btcc::TaskInput) -> String {
    match input.usage {
        TaskInputUse::Facts => String::new(),
        TaskInputUse::Artifact => " [artifact: revise this output]".into(),
        TaskInputUse::Verify => format!(
            " [verify: re-check because {}]",
            input.reason.as_deref().unwrap_or("")
        ),
    }
}

fn render_owned(scope: &crate::btcc::TaskScope) -> String {
    scope
        .owns
        .iter()
        .map(|o| {
            format!(
                "{} {}",
                o.subject,
                if o.aspects.is_empty() {
                    "*".into()
                } else {
                    o.aspects.join(", ")
                }
            )
        })
        .chain(scope.paths.iter().cloned())
        .collect::<Vec<_>>()
        .join("; ")
}
