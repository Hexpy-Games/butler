//! Source runtime-owned open disposition for ordinary Turn closeout.

use crate::btcc::{
    BtccError, ClaimCloseoutCorrectionInput, DispositionInput, DispositionStatus,
    DurableWorkStatus, RuntimeOwnedOpenGeneration, WorkView, disposition_material_fingerprint,
};

use super::NativeGuidedWork;

pub(super) async fn settle_open(
    adapter: &NativeGuidedWork,
    bound: &WorkView,
    candidate: &str,
) -> Result<String, BtccError> {
    let copy = copy(adapter);
    adapter
        .service
        .claim_closeout_correction(ClaimCloseoutCorrectionInput {
            scope: adapter.scope.clone(),
            work_id: bound.work_id.clone(),
        })
        .await?;
    let current = adapter
        .service
        .bound_work_for_turn(adapter.scope.turn_id.clone())
        .await?;
    let current = current
        .filter(|item| item.work_id == bound.work_id)
        .ok_or_else(|| {
            BtccError::new(
                "guided_work_binding_changed",
                "Runtime-owned open Work binding changed before settlement",
            )
        })?;
    let fingerprint = disposition_material_fingerprint(&current)?;
    let identity = format!(
        "btcc-guided-work-runtime-open.v2\0{}\0{}\0{}",
        adapter.scope.turn_id, bound.work_id, fingerprint
    );
    let mutation_call_id = crate::btcc::digest_identity(&identity);
    let persisted = adapter
        .service
        .record_disposition(DispositionInput {
            scope: adapter.scope.clone(),
            mutation_call_id,
            work_id: bound.work_id.clone(),
            disposition: DispositionStatus::Open,
            summary: copy.summary.into(),
            action_updates: Some(vec![]),
            remaining_actions: Some(vec![]),
            next_condition: Some(copy.next_condition.into()),
            evidence_refs: Some(vec![]),
            followups: Some(vec![]),
            backfill_tool_call_ids: None,
            expected_material_fingerprint: Some(fingerprint),
            runtime_owned_open_generation: Some(RuntimeOwnedOpenGeneration { version: 1 }),
        })
        .await;
    let persisted = match persisted {
        Ok(value) => value,
        Err(error) if publication_failure(&error) => {
            return Ok(crate::public_text::trim_js_whitespace(candidate).into());
        }
        Err(error) => return Err(error),
    };
    if persisted.status == DurableWorkStatus::Completed
        && super::decision::fresh(Some(&persisted), &adapter.scope.turn_id)?
    {
        return Ok(crate::public_text::trim_js_whitespace(candidate).into());
    }
    if persisted.status != DurableWorkStatus::Open
        || !super::decision::fresh(Some(&persisted), &adapter.scope.turn_id)?
    {
        return Err(BtccError::new(
            "guided_work_disposition_not_current",
            "Runtime-owned open disposition was not current",
        ));
    }
    Ok(notice(adapter, candidate))
}

pub(super) fn publication_failure(error: &BtccError) -> bool {
    error.code == "project_ledger_effect_not_applied"
        || error.code == "project_ledger_effect_uncertain"
}

pub(super) fn notice(adapter: &NativeGuidedWork, candidate: &str) -> String {
    let notice = copy(adapter).notice;
    let content = crate::public_text::trim_js_whitespace(candidate);
    if content.starts_with(&format!("{notice}\n\n")) {
        content.into()
    } else {
        format!("{notice}\n\n{content}")
    }
}

struct Copy {
    summary: &'static str,
    next_condition: &'static str,
    notice: &'static str,
}
fn copy(adapter: &NativeGuidedWork) -> Copy {
    let lower = adapter.response_language.to_lowercase();
    let korean = adapter.response_language.chars().any(hangul)
        || adapter.original_request.chars().any(hangul)
        || lower.contains("korean")
        || lower.contains("korea")
        || lower.contains("ko");
    if korean {
        Copy {
            summary: "현재 Turn의 완료 상태를 확정하지 못해 Work를 열린 상태로 유지했습니다.",
            next_condition: "현재 결과와 완료 조건을 확인한 뒤 Work 종료 상태를 다시 기록해야 합니다.",
            notice: "작업 완료 상태를 확정하지 못해 Work를 열린 상태로 유지했습니다.",
        }
    } else {
        Copy {
            summary: "The current Turn could not confirm completion, so the Work remains open.",
            next_condition: "Review the current results and completion conditions, then record the Work disposition again.",
            notice: "Work completion could not be confirmed, so the Work remains open.",
        }
    }
}
fn hangul(ch: char) -> bool {
    ('가'..='힣').contains(&ch)
}
