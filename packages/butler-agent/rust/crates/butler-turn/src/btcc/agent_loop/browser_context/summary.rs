use super::{ModelRoundToolCall, Value, field};

pub(super) fn steps(output: &Value) -> String {
    if let Some(summary) = field(output, "steps").as_str() {
        return summary.into();
    }
    let Some(steps) = field(output, "steps").as_array() else {
        return "0/0 completed".into();
    };
    let completed = steps
        .iter()
        .filter(|step| field(step, "status") == "completed")
        .count();
    let mut parts = vec![format!("{completed}/{} completed", steps.len())];
    if let Some((index, step)) = steps
        .iter()
        .enumerate()
        .find(|(_, step)| field(step, "status") != "completed")
    {
        parts.push(format!(
            "#{} {} {}",
            index + 1,
            field(step, "status").as_str().unwrap_or("unknown"),
            field(step, "reason").as_str().unwrap_or("unknown")
        ));
        let remaining = steps.len() - index - 1;
        if remaining > 0 {
            parts.push(format!("{remaining} not_dispatched"));
        }
    }
    parts.join("; ")
}

pub(super) fn acted(call: &ModelRoundToolCall, output: &Value) -> String {
    let summary = steps(output);
    let completed = summary
        .split('/')
        .next()
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(0);
    let mut groups: Vec<(String, usize)> = Vec::new();
    for step in call
        .arguments
        .get("steps")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(completed)
    {
        let action = field(step, "action").as_str().unwrap_or("act");
        // Keyboard and wait steps have no target; their value identifies them.
        let target = match action {
            "press" | "type" | "wait" => field(step, "value")
                .as_str()
                .map(|value| value.chars().take(24).collect::<String>()),
            _ => field(step, "ref").as_str().map(str::to_owned),
        };
        let label = format!("{action} {}", target.as_deref().unwrap_or("point"));
        if let Some((_, count)) = groups.last_mut().filter(|(last, _)| *last == label) {
            *count += 1;
        } else {
            groups.push((label, 1));
        }
    }
    let mut parts: Vec<_> = groups
        .into_iter()
        .map(|(label, count)| format!("{label} ×{count} completed"))
        .collect();
    parts.extend(summary.split("; ").skip(1).map(str::to_owned));
    parts.join("; ")
}
