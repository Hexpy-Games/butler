use std::collections::{HashMap, HashSet};

use crate::btcc::{WorkContext, WorkView};

fn word<T: serde::Serialize>(value: &T) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_default()
}

fn line(value: &str, limit: Option<usize>) -> String {
    let collapsed = crate::json::Utf16Prefix::new(value, usize::MAX)
        .collapse_whitespace(crate::public_text::is_js_whitespace);
    collapsed
        .prefix(limit.unwrap_or(usize::MAX))
        .utf8_for_hash()
        .into_owned()
}

fn list(values: &[String], limit: usize, item_limit: usize) -> String {
    let mut result = values
        .iter()
        .take(limit)
        .map(|value| line(value, Some(item_limit)))
        .collect::<Vec<_>>()
        .join("; ");
    if values.len() > limit {
        result.push_str(&format!("; (+{} more)", values.len() - limit));
    }
    result
}

mod reviews;

use reviews::{available_reviews, current_completion_validation, current_result_review};

fn executable(work: &WorkView) -> Vec<String> {
    let Some(plan) = &work.current_plan else {
        return Vec::new();
    };
    let statuses: HashMap<_, _> = work
        .action_progress
        .iter()
        .map(|progress| (progress.action_key.as_str(), word(&progress.status)))
        .collect();
    plan.actions
        .iter()
        .filter(|action| {
            let status = statuses.get(action.action_key.as_str()).map(String::as_str);
            if status.is_some_and(|status| matches!(status, "done" | "skipped" | "blocked")) {
                return false;
            }
            action.dependency_keys.iter().all(|key| {
                statuses
                    .get(key.as_str())
                    .is_some_and(|status| matches!(status.as_str(), "done" | "skipped"))
            })
        })
        .map(|action| action.action_key.clone())
        .collect()
}

fn corrections(rows: &mut Vec<String>, label: &str, values: &[String]) {
    if !values.is_empty() {
        rows.push(format!("{label}: {}", list(values, 4, 100)));
    }
}

pub(in crate::host) fn render(context: Option<&WorkContext>) -> Option<String> {
    let context = context?;
    let work = &context.work;
    let plan = work.current_plan.as_ref();
    let action_keys = executable(work);
    let action_set: HashSet<_> = action_keys.iter().map(String::as_str).collect();
    let statuses: HashMap<_, _> = work
        .action_progress
        .iter()
        .map(|progress| (progress.action_key.as_str(), progress))
        .collect();
    let mut rows = vec![
        format!("Status: {}", word(&work.status)),
        format!(
            "Current stage: {}",
            work.current_stage
                .as_ref()
                .map(word)
                .unwrap_or_else(|| "not recorded".into())
        ),
        format!(
            "Plan execution ownership: {}",
            plan.and_then(|plan| plan.execution_mode.as_ref())
                .map(word)
                .unwrap_or_else(|| {
                    "not yet recorded; replace and review the Plan before new owned execution"
                        .into()
                })
        ),
        format!(
            "Allowed next stages: {}",
            if work.allowed_next_stages.is_empty() {
                "none".into()
            } else {
                work.allowed_next_stages
                    .iter()
                    .map(word)
                    .collect::<Vec<_>>()
                    .join(", ")
            }
        ),
        format!("Available review subjects: {}", available_reviews(work)),
        format!("Stable Work objective: {}", line(&work.objective, None)),
        format!(
            "Explicit relation Work id (model-only; never report to user): {}",
            work.work_id
        ),
    ];
    if plan
        .and_then(|plan| plan.execution_mode.as_ref())
        .is_some_and(|mode| word(mode) == "steward")
    {
        rows.push("Execution next step: delegate_to_steward after Plan Review; Butler manages this Work and synthesizes the returned result, without executing the assigned actions itself.".into());
    }
    match work.current_stage.as_ref().map(word).as_deref() {
        Some("review") => rows.push("Optional stage focus: review the current Plan or actual execution result and record material corrections when that quality check is useful.".into()),
        Some("validation") => rows.push("Optional stage focus: validate the whole Work against the original request, current Plan and checks, terminal actions, actual results, and effect receipts.".into()),
        _ => {}
    }
    if let Some(plan) = plan {
        if plan.objective != work.objective {
            rows.push(format!(
                "Current Plan focus: {}",
                line(&plan.objective, None)
            ));
        }
        if !plan.governing_refs.is_empty() {
            rows.push(format!(
                "Governing references: {}",
                list(&plan.governing_refs, 12, 160)
            ));
        }
        let progress = plan
            .actions
            .iter()
            .map(|action| {
                format!(
                    "{}={}",
                    line(&action.action_key, Some(52)),
                    statuses
                        .get(action.action_key.as_str())
                        .map(|progress| word(&progress.status))
                        .unwrap_or_else(|| "pending".into())
                )
            })
            .collect::<Vec<_>>();
        rows.push(format!(
            "Action progress: {}",
            if progress.is_empty() {
                "none".into()
            } else {
                list(&progress, 24, 72)
            }
        ));
        if !plan.checks.is_empty() {
            rows.push(format!("Checks: {}", list(&plan.checks, 20, 240)));
        }
    }
    for blocker in work
        .effect_blockers
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .take(3)
    {
        rows.push(format!("Unresolved prior effect ({} -> {}): {} Reconcile this exact target before another effect.", line(&blocker.capability, Some(60)), line(&blocker.target, Some(100)), line(&blocker.detail, Some(180))));
    }
    if let Some(review) = &work.latest_plan_review {
        let label = if plan.is_some_and(|plan| {
            Some(&plan.plan_revision_id) == review.bound_plan_revision_id.as_ref()
        }) {
            "Latest plan review"
        } else {
            "Latest plan review (outdated)"
        };
        rows.push(format!(
            "{label}: {} — {}",
            word(&review.verdict),
            line(&review.summary, Some(260))
        ));
        corrections(&mut rows, "Plan corrections", &review.corrections);
    }
    if let Some(review) = &work.latest_result_review {
        let label = if current_result_review(work) {
            "Latest result review"
        } else {
            "Latest result review (outdated)"
        };
        rows.push(format!(
            "{label}: {} — {}",
            word(&review.verdict),
            line(&review.summary, Some(260))
        ));
        corrections(&mut rows, "Result corrections", &review.corrections);
    }
    if let Some(review) = &work.latest_completion_validation {
        let label = if current_completion_validation(work) {
            "Latest completion validation"
        } else {
            "Latest completion validation (outdated)"
        };
        rows.push(format!(
            "{label}: {} — {}",
            word(&review.verdict),
            line(&review.summary, Some(260))
        ));
        corrections(
            &mut rows,
            "Completion validation corrections",
            &review.corrections,
        );
    }
    if let Some(disposition) = &work.latest_disposition {
        rows.push(format!(
            "Latest Work disposition: {} — {}",
            word(&disposition.disposition),
            line(&disposition.summary, Some(300))
        ));
        if !disposition.remaining_actions.is_empty() {
            rows.push(format!(
                "Disposition remaining actions: {}",
                list(&disposition.remaining_actions, 6, 120)
            ));
        }
        if let Some(condition) = disposition
            .next_condition
            .as_deref()
            .filter(|value| !value.is_empty())
        {
            rows.push(format!(
                "Disposition next condition: {}",
                line(condition, Some(300))
            ));
        }
    }
    rows.push("Guardrail: follow the current Work policy, stay within the original request and governing checks, and settle the bound Work with a truthful disposition before reporting.".into());
    if let Some(plan) = plan {
        rows.push(format!(
            "Executable action keys: {}",
            if action_keys.is_empty() {
                "none".into()
            } else {
                action_keys.join(", ")
            }
        ));
        rows.push("Current executable plan details:".into());
        let mut actions = plan.actions.iter().collect::<Vec<_>>();
        actions.sort_by_key(|action| {
            statuses
                .get(action.action_key.as_str())
                .is_some_and(|progress| {
                    matches!(word(&progress.status).as_str(), "done" | "skipped")
                })
        });
        for action in actions {
            let progress = statuses.get(action.action_key.as_str());
            let status = progress
                .map(|progress| word(&progress.status))
                .unwrap_or_else(|| "pending".into());
            if matches!(status.as_str(), "done" | "skipped")
                || !action_set.contains(action.action_key.as_str())
            {
                continue;
            }
            let dependencies = if action.dependency_keys.is_empty() {
                String::new()
            } else {
                format!(" (after: {})", action.dependency_keys.join(", "))
            };
            let effect = action
                .effect
                .as_ref()
                .filter(|value| super::js_truthy(value))
                .map(|value| {
                    format!(
                        " [effect: {} -> {}]",
                        line(
                            value
                                .get("capability")
                                .and_then(|value| value.as_str())
                                .unwrap_or("undefined"),
                            Some(80)
                        ),
                        line(
                            value
                                .get("target")
                                .and_then(|value| value.as_str())
                                .unwrap_or("undefined"),
                            Some(160)
                        )
                    )
                })
                .unwrap_or_default();
            let note = progress
                .and_then(|progress| progress.note.as_deref())
                .filter(|value| !value.is_empty())
                .map(|note| format!(" — {}", line(note, Some(180))))
                .unwrap_or_default();
            rows.push(format!(
                "- [{status}, executable] {}: {}{dependencies}{effect}{note}",
                line(&action.action_key, Some(80)),
                line(&action.description, Some(280))
            ));
        }
    }
    if let Some(checkpoint) = &work.latest_checkpoint {
        if !checkpoint.public_summary.is_empty() {
            rows.push(format!(
                "Latest progress ({}): {}",
                word(&checkpoint.stage),
                line(&checkpoint.public_summary, Some(600))
            ));
        }
        if !checkpoint.next_step.is_empty() {
            rows.push(format!(
                "Next step: {}",
                line(&checkpoint.next_step, Some(400))
            ));
        }
    }
    rows.push("Prior operation requests and results remain available through list_operation_results and read_operation_results; this context contains current Work state, not a duplicate of execution history.".into());
    rows.push(format!(
        "Original request (highest priority): {}",
        line(&context.original_request.content, None)
    ));
    Some(rows.join("\n"))
}
