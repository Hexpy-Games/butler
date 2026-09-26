mod promotions;

use serde_json::Value;

use crate::cognition::CognitionResult;

use super::types::{ProjectCapsuleSourceCounts, ProjectCapsuleSourceSnapshot, TaskSummary};
use promotions::{
    PromotionCategory, collect_promotions, compact, extend_promotions, js_string, render_promotions,
};

const MAX_BYTES: usize = 12_000;

pub(super) fn render(
    project_id: &str,
    snapshot: &ProjectCapsuleSourceSnapshot,
    counts: &mut ProjectCapsuleSourceCounts,
    now_epoch_ms: i64,
) -> CognitionResult<String> {
    let workspace = snapshot
        .workspace_path
        .as_deref()
        .filter(|path| !path.is_empty());
    let registry = snapshot.registry.as_ref();
    let promotions = collect_promotions(snapshot);
    counts.promoted = promotions.values().map(Vec::len).sum();
    let now = crate::js_date::format_iso_millis(now_epoch_ms)
        .unwrap_or_else(|| "1970-01-01T00:00:00.000Z".to_owned());
    let aliases = registry
        .and_then(|value| value.get("aliases"))
        .and_then(Value::as_array)
        .filter(|values| !values.is_empty())
        .map(|values| values.iter().map(js_string).collect::<Vec<_>>().join(", "));
    let description = registry
        .and_then(|value| value.get("description"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(|value| compact(value, 220));
    let mut lines = vec![
        format!("# Project Memory: {project_id}"),
        String::new(),
        "## Identity".into(),
        format!("- project_id: {project_id}"),
        workspace.map_or_else(
            || "- canonical_path: unknown".into(),
            |path| format!("- canonical_path: {path}"),
        ),
        description.map_or_else(
            || "- purpose: unknown".into(),
            |value| format!("- purpose: {value}"),
        ),
        aliases.map_or_else(String::new, |value| format!("- aliases: {value}")),
        String::new(),
        "## Structure".into(),
        workspace.map_or_else(
            || "- Workspace path: unknown".into(),
            |path| format!("- Workspace path: {path}"),
        ),
        "- Structure refresh is pending deeper repository inspection.".into(),
        String::new(),
        "## Conventions".into(),
    ];
    extend_promotions(&mut lines, PromotionCategory::Conventions, &promotions);
    lines.extend([String::new(), "## Active Work".into()]);
    if snapshot.tasks.is_empty() {
        lines.push("- No recent project tasks found.".into());
    } else {
        for task in &snapshot.tasks {
            lines.push(render_task(task));
        }
    }
    lines.extend([String::new(), "## Decisions".into()]);
    if let Some(decisions) = promotions.get(&PromotionCategory::Decisions)
        && !decisions.is_empty()
    {
        render_promotions(&mut lines, PromotionCategory::Decisions, decisions);
    } else if !snapshot.evidence.is_empty() {
        for item in &snapshot.evidence {
            lines.push(format!(
                "- Review memory evidence {} before promoting durable decisions. (provenance: memory-evidence:{})",
                item.path, item.path
            ));
        }
    } else {
        lines.push("- No durable project decisions have been promoted yet.".into());
    }
    lines.extend([String::new(), "## Feedback".into()]);
    if snapshot.feedback.is_empty() {
        lines.push("- No project-local hot cache was found.".into());
    } else {
        for item in &snapshot.feedback {
            lines.push(format!(
                "- Explicit project feedback: {} (provenance: explicit-project-rule:{})",
                compact(&item.text, 320),
                item.path
            ));
        }
    }
    extend_promotions(&mut lines, PromotionCategory::Feedback, &promotions);
    lines.extend([String::new(), "## Risks".into()]);
    extend_promotions(&mut lines, PromotionCategory::Risks, &promotions);
    lines.extend([
        String::new(),
        "## Freshness".into(),
        format!("- refreshed_at: {now}"),
        format!(
            "- source_counts: registry={}, tasks={}, explicit_feedback={}, project_hot_cache={}, memory_evidence={}, graph_evidence={}, promoted={}",
            counts.registry,
            counts.tasks,
            counts.explicit_feedback,
            counts.project_hot_cache,
            counts.memory_evidence,
            counts.graph_evidence,
            counts.promoted,
        ),
        "- confidence: partial; refresh uses bounded registry, task, hot-cache, memory-evidence, and graph inputs.".into(),
    ]);
    Ok(bounded_markdown(lines))
}

fn render_task(task: &TaskSummary) -> String {
    let request = if task.request.is_empty() {
        &task.id
    } else {
        &task.request
    };
    let result = if task.result.is_empty() {
        String::new()
    } else {
        format!(" -> {}", compact(&task.result, 180))
    };
    format!(
        "- [{}] {}{} (provenance: task:{})",
        task.status,
        compact(request, 180),
        result,
        task.id
    )
}

fn bounded_markdown(lines: Vec<String>) -> String {
    let mut lines = lines
        .into_iter()
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();
    let mut body = markdown_text(&lines);
    while body.len() > MAX_BYTES {
        let Some(index) = lines.iter().rposition(|line| line.starts_with("- ")) else {
            break;
        };
        lines.remove(index);
        body = markdown_text(&lines);
    }
    if body.len() <= MAX_BYTES {
        return body;
    }
    let suffix = "\n\n[truncated]\n";
    if suffix.len() >= MAX_BYTES {
        return prefix_bytes(&body, MAX_BYTES).to_owned();
    }
    format!(
        "{}{}",
        prefix_bytes(&body, MAX_BYTES - suffix.len()).trim_end(),
        suffix
    )
}

fn markdown_text(lines: &[String]) -> String {
    format!("{}\n", lines.join("\n").trim())
}

fn prefix_bytes(value: &str, limit: usize) -> &str {
    if value.len() <= limit {
        return value;
    }
    let mut end = limit;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    &value[..end]
}
