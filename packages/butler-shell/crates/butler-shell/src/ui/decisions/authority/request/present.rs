//! The card's content in the app language (`approvalRequestView`, `browserHandoffView`).
use super::{
    ActionKind, Approval, Authority, Card, DETAIL_TARGET_KINDS, Line, MAX_EXAMPLES, Operation, Risk,
    View, has_outside, tool_titles, workspace_label,
};

/// `approvalRequestView`: a sentence per action kind; the generic sentence for an unknown kind;
/// the legacy `scope` text (then the reason) from an agent that sends no `approval`.
pub(crate) fn view(card: &Card, copy: Authority) -> View {
    let Some(approval) = &card.approval else {
        return View {
            title: match &card.scope {
                Some((title, description)) => format!("{title} · {description}"),
                None => card.reason.clone(),
            },
            details: Vec::new(),
            risk: Risk::High,
            conversation_scope: card.scope.as_ref().map(|(_, d)| d.clone()),
            action_kind: ActionKind::Other,
        };
    };
    let kind = ActionKind::parse(&approval.action_kind);
    let workspace = workspace_label(approval);
    let label = approval
        .operation
        .as_ref()
        .and_then(|o| tool_titles::tool(copy.lang(), &o.tool))
        .filter(|l| !l.is_empty());
    let sentence_kind = matches!(kind, ActionKind::WebRequest | ActionKind::ManageSchedule);
    let image_kind = matches!(kind, ActionKind::GenerateImage | ActionKind::EditImage);
    let title = match (&approval.operation, label) {
        (Some(op), Some(label)) if !image_kind && !sentence_kind => {
            copy.operation(label, op.read_only)
        }
        _ => sentence(kind, approval, workspace, copy),
    };
    let mut details = Vec::new();
    if card.reason == "authority.taintReason" {
        details.push(Line::Text(copy.taint_reason().to_owned()));
    }
    if card.reason == "authority.unsandboxedReason" {
        details.push(Line::Text(copy.unsandboxed_reason().to_owned()));
    }
    if kind == ActionKind::WebRequest {
        details.push(Line::Text(copy.web_request_desc().to_owned()));
    }
    details.extend(action_details(approval, kind, card, copy));
    let conversation_scope = if has_outside(approval) {
        copy.covers_other().to_owned()
    } else if kind == ActionKind::EditFiles {
        copy.covers_edit_files(workspace)
    } else if kind.is_command_kind() {
        copy.covers_command(workspace)
    } else {
        copy.covers_other().to_owned()
    };
    View {
        title,
        details,
        risk: approval.risk.unwrap_or(Risk::High),
        conversation_scope: Some(conversation_scope),
        action_kind: kind,
    }
}

fn sentence(kind: ActionKind, approval: &Approval, workspace: Option<&str>, copy: Authority) -> String {
    let outside = has_outside(approval);
    match kind {
        ActionKind::GenerateImage => tool_label(copy, "generate_image"),
        ActionKind::EditImage => tool_label(copy, "edit_image"),
        ActionKind::EditFiles if outside => copy.edit_files_outside(approval.count),
        ActionKind::EditFiles => copy.edit_files(approval.count, workspace),
        ActionKind::RunCommand if outside => copy.run_command_outside().to_owned(),
        ActionKind::RunCommand => copy.run_command(workspace),
        ActionKind::WebRequest => copy.web_request().to_owned(),
        ActionKind::NetworkCommand if outside => copy.network_command_outside().to_owned(),
        ActionKind::NetworkCommand => copy.network_command(workspace),
        ActionKind::UseConnector => {
            let path = approval
                .targets
                .iter()
                .find(|t| t.kind == "connector")
                .map_or("", |t| t.path.trim());
            match path.find('/').filter(|slash| *slash > 0) {
                Some(slash) => {
                    let tool = &path[slash + 1..];
                    copy.use_connector((!tool.is_empty()).then_some(tool), Some(&path[..slash]))
                }
                None => copy.use_connector((!path.is_empty()).then_some(path), None),
            }
        }
        ActionKind::ManageSchedule => copy.manage_schedule(schedule_operation(approval)).to_owned(),
        ActionKind::UpdateProject => copy.update_project().to_owned(),
        ActionKind::StartConversation => copy.start_conversation().to_owned(),
        ActionKind::RestartService => copy.restart_service().to_owned(),
        ActionKind::CreateWorktree => copy.create_worktree().to_owned(),
        ActionKind::SwitchFolder => copy.switch_folder().to_owned(),
        ActionKind::Other => copy.generic().to_owned(),
    }
}

fn tool_label(copy: Authority, name: &str) -> String {
    tool_titles::tool(copy.lang(), name)
        .unwrap_or_else(|| tool_titles::tool_fallback(copy.lang()))
        .to_owned()
}

/// `automation:create:<id>`, `automation:delete_automation:<id>` or `automation:due:<now>`.
fn schedule_operation(approval: &Approval) -> &'static str {
    let path = approval
        .targets
        .iter()
        .find(|t| t.kind == "schedule")
        .map_or("", |t| t.path.as_str());
    match path.split(':').nth(1).unwrap_or_default() {
        "create" => "create",
        "delete" | "delete_automation" => "delete",
        "due" => "run",
        _ => "change",
    }
}

/// The action's details, separate from permission notices and card explanations.
fn action_details(approval: &Approval, kind: ActionKind, card: &Card, copy: Authority) -> Vec<Line> {
    if let Some(schedule) = &approval.schedule {
        let mut lines = vec![schedule.title.clone()];
        if schedule.kind != "update" {
            lines.push(crate::ui::decisions::authority::schedule::timing(schedule, copy));
        } else if schedule.access_mode.is_none()
            && schedule.browser_signin.is_none()
            && schedule.browser_payment.is_none()
        {
            lines.push(copy.schedule_unavailable().to_owned());
        }
        if let Some(mode) = &schedule.access_mode {
            lines.push(copy.schedule_mode(copy.access_label(mode)));
        }
        lines.extend(schedule.browser_signin.map(|on| copy.schedule_signin(on)));
        lines.extend(schedule.browser_payment.map(|on| copy.schedule_payment(on)));
        lines.extend(approval.examples.iter().cloned());
        return lines.into_iter().filter(|l| !l.is_empty()).map(Line::Text).collect();
    }
    if kind == ActionKind::ManageSchedule {
        return vec![Line::Text(copy.schedule_unavailable().to_owned())];
    }
    let Some(operation) = &approval.operation else {
        return details(approval, kind, card, copy);
    };
    // An example is a capped copy of the command: a prefix of the whole command is a duplicate.
    let examples = approval.examples.iter().filter(|example| {
        operation
            .command
            .as_ref()
            .is_none_or(|command| *example == command || !command.starts_with(example.as_str()))
    });
    let mut lines = operation_details(operation, copy);
    lines.extend(examples.map(|example| {
        if kind.is_command_kind() {
            Line::Code(example.clone())
        } else {
            Line::Text(example.clone())
        }
    }));
    // Each text shows once, as its first line.
    let mut unique: Vec<Line> = Vec::new();
    for line in lines {
        if !unique.iter().any(|other| other.text() == line.text()) {
            unique.push(line);
        }
    }
    unique
}

/// The exact operation, as the local decision shows it.
fn operation_details(operation: &Operation, copy: Authority) -> Vec<Line> {
    if let Some(image) = &operation.image {
        let [model, size, quality_label, prompt, default] = copy.image_labels();
        let size_text = if image.size == "auto" { default } else { image.size.as_str() };
        let quality = if image.quality == "auto" {
            default
        } else {
            copy.image_quality(&image.quality).unwrap_or(image.quality.as_str())
        };
        return vec![
            Line::Text(format!("{model}: {}", image.model)),
            Line::Text(format!("{size}: {size_text}")),
            Line::Text(format!("{quality_label}: {quality}")),
            Line::Text(format!("{prompt}: {}", image.prompt)),
        ];
    }
    let mut lines: Vec<Line> = operation.command.iter().cloned().map(Line::Code).collect();
    for (index, target) in operation.targets.iter().enumerate() {
        lines.push(Line::Text(match (index, operation.browser_signed_in) {
            (0, Some(signed_in)) => format!("{target} · {}", copy.browser_mode(signed_in)),
            _ => target.clone(),
        }));
    }
    if operation.tool == "browser_sign_in_wait" {
        let step = operation.sign_in_step.as_deref().unwrap_or("unknown_form");
        lines.push(Line::Text(copy.sign_in_step(step).to_owned()));
    }
    if operation.tool == "browser_pay_wait" {
        let reason = operation.wait_reason.as_deref().unwrap_or("unknown_form");
        lines.push(Line::Text(copy.pay_step(reason).to_owned()));
    }
    for step in operation.browser_steps.iter().flatten() {
        let mut parts = vec![copy.browser_step(&step.action, &step.role, &step.name, &step.frame)];
        parts.extend(step.value_preview.clone());
        parts.extend(step.addons.iter().cloned());
        parts.retain(|p| !p.is_empty());
        lines.push(Line::Text(parts.join(" · ")));
    }
    lines
}

/// Up to three examples as the card shows them: a capped one ends in `…`.
fn shown_examples(approval: &Approval) -> Vec<String> {
    approval
        .examples
        .iter()
        .take(MAX_EXAMPLES)
        .enumerate()
        .map(|(index, example)| {
            let cut = approval.examples_truncated.as_ref().is_some_and(|t| t[index]);
            if cut { format!("{example}…") } else { example.clone() }
        })
        .collect()
}

fn details(approval: &Approval, kind: ActionKind, card: &Card, copy: Authority) -> Vec<Line> {
    let shown = shown_examples(approval);
    if !shown.is_empty() {
        let outside = approval.targets.iter().filter(|t| t.kind == "outside").map(|t| t.path.clone());
        let additional: Vec<String> = outside.filter(|path| !shown.contains(path)).collect();
        let extra = if kind == ActionKind::EditFiles { i64::try_from(additional.len()).unwrap_or(i64::MAX) } else { 0 };
        let rest = approval.count - i64::try_from(shown.len()).unwrap_or(i64::MAX) - extra;
        let mut lines = Vec::new();
        if approval.unisolated_read_only {
            lines.push(Line::Text(copy.read_only_unisolated().to_owned()));
        }
        lines.extend(additional.into_iter().map(Line::Text));
        lines.extend(shown.into_iter().map(|example| {
            if kind.is_command_kind() { Line::Code(example) } else { Line::Text(example) }
        }));
        if rest > 0 {
            lines.push(Line::Text(copy.more(rest)));
        }
        return lines;
    }
    // Without examples, say what the request acts on: its targets, else the reason.
    let lines: Vec<Line> = approval
        .targets
        .iter()
        .filter(|t| DETAIL_TARGET_KINDS.contains(&t.kind.as_str()))
        .map(|t| t.path.trim())
        .filter(|path| !path.is_empty())
        .map(|path| Line::Text(path.to_owned()))
        .collect();
    if !lines.is_empty() || kind != ActionKind::Other {
        return lines;
    }
    let fallback = card.scope.as_ref().map_or(card.reason.as_str(), |(_, d)| d.as_str()).trim();
    if fallback.is_empty() { Vec::new() } else { vec![Line::Text(fallback.to_owned())] }
}

/// Whether the request is a hand-off to the browser surface.
pub(crate) fn is_handoff(card: &Card) -> bool {
    card.approval
        .as_ref()
        .and_then(|a| a.operation.as_ref())
        .is_some_and(|o| {
            matches!(
                o.tool.as_str(),
                "browser_sign_in_wait" | "browser_pay_wait" | "browser_wait_for_user"
            )
        })
}
