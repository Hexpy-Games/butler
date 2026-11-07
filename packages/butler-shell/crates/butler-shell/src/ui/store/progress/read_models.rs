//! `activity.ts` read models: what each visible progress row stands for.
use butler_ds::ui::context::Lang;

use super::activity::text;
use super::row_ops::is_terminal_state;
use crate::ui::source::wire::{ProgressDetailRow, ProgressRow};

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum ActivityReadModel {
    Receipt {
        label: String,
        state: String,
        receipt_kind: String,
    },
    Decision {
        summary: String,
        rationale: Option<String>,
        next_step: Option<String>,
        source: String,
        model_call_id: Option<String>,
        latency_ms: Option<i64>,
        evidence_refs: Option<Vec<String>>,
    },
    WorkBlock {
        id: String,
        label: Option<String>,
        state: String,
    },
    ToolControl {
        tool_name: String,
        input_label: Option<String>,
        label: String,
        tool_call_id: Option<String>,
        work_block_id: Option<String>,
    },
    Observation {
        label: String,
        detail_rows: Option<Vec<ProgressDetailRow>>,
    },
    Outcome {
        state: String,
        public_summary: String,
    },
    RuntimeFault {
        fault_id: String,
        kind: String,
        retryable: bool,
        public_summary: String,
        safe_error_code: Option<String>,
        safe_cause: Option<String>,
    },
}

/// `projectActivityReadModels`.
pub(crate) fn project_activity_read_models(
    lang: Lang,
    rows: &[ProgressRow],
) -> Vec<ActivityReadModel> {
    rows.iter()
        .filter_map(|row| read_model(lang, row))
        .collect()
}

fn is_public_decision_source(value: Option<&str>) -> bool {
    matches!(
        value,
        Some("assistant-authored" | "model-authored" | "principal-authored")
    )
}

fn is_tool_control_row(row: &ProgressRow) -> bool {
    if matches!(row.kind.as_deref(), Some("decision" | "work_block")) {
        return false;
    }
    text(&row.safe_tool_name).is_some()
        || text(&row.safe_input_label).is_some()
        || text(&row.tool_call_id).is_some()
}

fn read_model(lang: Lang, row: &ProgressRow) -> Option<ActivityReadModel> {
    if let (Some(id), Some(kind), Some(summary)) = (
        text(&row.runtime_fault_id),
        text(&row.runtime_fault_kind),
        text(&row.runtime_fault_public_summary),
    ) {
        return Some(ActivityReadModel::RuntimeFault {
            fault_id: id.to_string(),
            kind: kind.to_string(),
            retryable: row.runtime_fault_retryable == Some(true),
            public_summary: summary.to_string(),
            safe_error_code: row.runtime_fault_safe_error_code.clone(),
            safe_cause: row.runtime_fault_safe_cause.clone(),
        });
    }
    if let Some(receipt) = text(&row.receipt_kind) {
        return Some(ActivityReadModel::Receipt {
            label: row.safe_label.clone(),
            state: row.state.clone(),
            receipt_kind: receipt.to_string(),
        });
    }
    if row.kind.as_deref() == Some("decision")
        && is_public_decision_source(row.public_decision_source.as_deref())
    {
        let summary = text(&row.public_decision_summary)?;
        return Some(ActivityReadModel::Decision {
            summary: summary.to_string(),
            rationale: row.public_decision_rationale.clone(),
            next_step: row.public_decision_next_step.clone(),
            source: row.public_decision_source.clone().unwrap_or_default(),
            model_call_id: row.public_decision_model_call_id.clone(),
            latency_ms: row.public_decision_latency_ms,
            evidence_refs: row.public_decision_evidence_refs.clone(),
        });
    }
    if row.kind.as_deref() == Some("work_block")
        && let Some(id) = text(&row.work_block_id)
    {
        return Some(ActivityReadModel::WorkBlock {
            id: id.to_string(),
            label: row.work_block_label.clone(),
            state: row.state.clone(),
        });
    }
    if is_tool_control_row(row) {
        return Some(tool_control_model(lang, row));
    }
    if row.kind.as_deref() == Some("turn") && is_terminal_state(&row.state) {
        return Some(ActivityReadModel::Outcome {
            state: row.state.clone(),
            public_summary: row.safe_label.clone(),
        });
    }
    if row
        .safe_detail_rows
        .as_ref()
        .is_some_and(|rows| !rows.is_empty())
    {
        return Some(ActivityReadModel::Observation {
            label: row.safe_label.clone(),
            detail_rows: row.safe_detail_rows.clone(),
        });
    }
    None
}

fn tool_control_model(lang: Lang, row: &ProgressRow) -> ActivityReadModel {
    let tool_name = row
        .safe_tool_name
        .clone()
        .unwrap_or_else(|| tool_label(lang).to_string());
    let label = match (&row.safe_input_label, &row.safe_tool_name) {
        (Some(input), Some(tool)) if !input.is_empty() && !tool.is_empty() => {
            format!("{tool_name}: {input}")
        }
        _ => text(&row.safe_tool_name)
            .or(text(&row.safe_input_label))
            .unwrap_or(tool_label(lang))
            .to_string(),
    };
    ActivityReadModel::ToolControl {
        tool_name,
        input_label: row.safe_input_label.clone(),
        label,
        tool_call_id: row.tool_call_id.clone(),
        work_block_id: row.work_block_id.clone(),
    }
}

/// `appCopy.interfaceDetails.tool`.
fn tool_label(lang: Lang) -> &'static str {
    match lang {
        Lang::En => "Tool",
        Lang::Ko => "도구",
    }
}
