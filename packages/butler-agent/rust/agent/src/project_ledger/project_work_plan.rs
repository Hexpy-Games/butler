//! Source Project Work Plan observation for App session progress.

use std::path::Path;

use serde_json::Value;

use super::{ProjectLedgerReadError, committed, dashboard, records};
use crate::locale::LocaleCollation;

#[derive(Clone, Debug)]
pub(crate) struct ProjectWorkPlanRead {
    pub app_project_id: String,
    pub ledger_project_id: String,
    pub work_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ProjectWorkPlanFacts {
    pub approved: bool,
    pub action_keys: Vec<String>,
    pub completed_action_keys: Vec<String>,
}

pub(super) fn read(
    data_root: &Path,
    input: &ProjectWorkPlanRead,
    collation: &LocaleCollation,
) -> Result<Option<ProjectWorkPlanFacts>, ProjectLedgerReadError> {
    safe_id(&input.ledger_project_id)?;
    safe_id(&input.work_id)?;
    let root = data_root
        .join("project-ledger")
        .join("projects")
        .join(&input.ledger_project_id);
    let work_path = format!("work/{}/work.md", input.work_id);
    let Some(work) = committed::read_selected(&root, &work_path)? else {
        return Ok(None);
    };
    let manifest = dashboard::decode_manifest_body(
        records::frontmatter_body_ref(&work),
        &input.work_id,
        &input.app_project_id,
        &input.ledger_project_id,
        collation,
    )?;
    drop(work);
    let Some(plan_id) = manifest
        .get("currentPlanRevisionId")
        .and_then(Value::as_str)
    else {
        return Ok(None);
    };
    safe_id(plan_id)?;
    let plan_path = format!("plans/{}.md", plan_id.to_lowercase());
    let Some(plan_body) = committed::read_selected(&root, &plan_path)? else {
        return Ok(None);
    };
    let plan = dashboard::decode_child_body(
        records::frontmatter_body_ref(&plan_body),
        &input.work_id,
        plan_id,
        "butler.btcc-project-work-plan.v1",
        collation,
    )?;
    drop(plan_body);
    let action_keys = plan["plan"]["actions"]
        .as_array()
        .ok_or_else(invalid)?
        .iter()
        .map(|action| {
            action["actionKey"]
                .as_str()
                .map(str::to_owned)
                .ok_or_else(invalid)
        })
        .collect::<Result<Vec<_>, _>>()?;
    drop(plan);
    let completed_action_keys = manifest["actionProgress"]
        .as_array()
        .ok_or_else(invalid)?
        .iter()
        .filter(|entry| matches!(entry["status"].as_str(), Some("done" | "skipped")))
        .map(|entry| {
            entry["actionKey"]
                .as_str()
                .map(str::to_owned)
                .ok_or_else(invalid)
        })
        .collect::<Result<Vec<_>, _>>()?;
    let approved = if let Some(review_id) = manifest
        .get("latestPlanReviewRevisionId")
        .and_then(Value::as_str)
    {
        safe_id(review_id)?;
        let path = format!("references/{}.md", review_id.to_lowercase());
        if let Some(body) = committed::read_selected(&root, &path)? {
            let wrapper = dashboard::decode_child_body(
                records::frontmatter_body_ref(&body),
                &input.work_id,
                review_id,
                "butler.btcc-project-work-review.v1",
                collation,
            )?;
            let review = &wrapper["review"];
            review["verdict"].as_str() == Some("accept")
                && review["boundPlanRevisionId"].as_str() == Some(plan_id)
        } else {
            false
        }
    } else {
        false
    };
    Ok(Some(ProjectWorkPlanFacts {
        approved,
        action_keys,
        completed_action_keys,
    }))
}

fn safe_id(id: &str) -> Result<(), ProjectLedgerReadError> {
    if crate::public_text::trim_js_whitespace(id).is_empty()
        || id.encode_utf16().count() > 4096
        || matches!(id, "." | "..")
        || id.contains(['/', '\\'])
    {
        return Err(invalid());
    }
    Ok(())
}

fn invalid() -> ProjectLedgerReadError {
    ProjectLedgerReadError::RecordShow("project_work_managed_record_invalid")
}
