//! Source Project Work Plan observation for App session progress.

use std::path::{Path, PathBuf};

use serde::Deserialize;

use serde_json::Value;

use super::{ProjectLedgerReadError, committed, dashboard, records};
use butler_core::locale::LocaleCollation;

#[derive(Clone, Debug)]
pub struct ProjectWorkPlanRead {
    pub app_project_id: String,
    pub ledger_project_id: String,
    pub work_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProjectWorkPlanFacts {
    pub approved: bool,
    pub action_keys: Vec<String>,
    pub completed_action_keys: Vec<String>,
}

/// Plan facts of one managed Work for session progress: the current plan's
/// action keys, the ones done or skipped, and whether the latest plan review
/// accepted this plan.
pub(super) fn read(
    data_root: &Path,
    input: &ProjectWorkPlanRead,
    collation: &LocaleCollation,
) -> Result<Option<ProjectWorkPlanFacts>, ProjectLedgerReadError> {
    safe_id(&input.ledger_project_id)?;
    safe_id(&input.work_id)?;
    let reader = Reader {
        root: data_root
            .join("project-ledger")
            .join("projects")
            .join(&input.ledger_project_id),
        input,
        collation,
    };
    let work_path = format!("work/{}/work.md", input.work_id);
    let Some(work) = committed::read_selected(&reader.root, &work_path)? else {
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
    let Some(plan) = reader.child(
        &format!("plans/{}.md", plan_id.to_lowercase()),
        plan_id,
        "butler.btcc-project-work-plan.v1",
    )?
    else {
        return Ok(None);
    };
    let action_keys = PlanChild::deserialize(&plan)
        .map_err(|source| invalid().with_source(source))?
        .plan
        .actions
        .into_iter()
        .map(|action| action.action_key)
        .collect();
    drop(plan);
    let completed_action_keys = completed_action_keys(&manifest)?;
    Ok(Some(ProjectWorkPlanFacts {
        approved: reader.plan_approved(&manifest, plan_id)?,
        action_keys,
        completed_action_keys,
    }))
}

/// The current plan child: only its action keys are read.
#[derive(Deserialize)]
struct PlanChild {
    plan: PlanActions,
}

#[derive(Deserialize)]
struct PlanActions {
    actions: Vec<PlanActionKey>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanActionKey {
    action_key: String,
}

struct Reader<'a> {
    root: PathBuf,
    input: &'a ProjectWorkPlanRead,
    collation: &'a LocaleCollation,
}

impl Reader<'_> {
    /// A committed child record of the Work, decoded; `None` when absent.
    fn child(
        &self,
        path: &str,
        id: &str,
        schema: &str,
    ) -> Result<Option<Value>, ProjectLedgerReadError> {
        let Some(body) = committed::read_selected(&self.root, path)? else {
            return Ok(None);
        };
        dashboard::decode_child_body(
            records::frontmatter_body_ref(&body),
            &self.input.work_id,
            id,
            schema,
            self.collation,
        )
        .map(Some)
    }

    /// The latest plan review accepted `plan_id`.
    fn plan_approved(
        &self,
        manifest: &Value,
        plan_id: &str,
    ) -> Result<bool, ProjectLedgerReadError> {
        let Some(review_id) = manifest
            .get("latestPlanReviewRevisionId")
            .and_then(Value::as_str)
        else {
            return Ok(false);
        };
        safe_id(review_id)?;
        let Some(wrapper) = self.child(
            &format!("references/{}.md", review_id.to_lowercase()),
            review_id,
            "butler.btcc-project-work-review.v1",
        )?
        else {
            return Ok(false);
        };
        let review = wrapper.get("review");
        let text = |key: &str| {
            review
                .and_then(|review| review.get(key))
                .and_then(Value::as_str)
        };
        Ok(text("verdict") == Some("accept") && text("boundPlanRevisionId") == Some(plan_id))
    }
}

/// Action keys whose progress is done or skipped.
fn completed_action_keys(manifest: &Value) -> Result<Vec<String>, ProjectLedgerReadError> {
    manifest
        .get("actionProgress")
        .and_then(Value::as_array)
        .ok_or_else(invalid)?
        .iter()
        .filter(|entry| {
            matches!(
                entry.get("status").and_then(Value::as_str),
                Some("done" | "skipped")
            )
        })
        .map(|entry| {
            entry
                .get("actionKey")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .ok_or_else(invalid)
        })
        .collect()
}

fn safe_id(id: &str) -> Result<(), ProjectLedgerReadError> {
    if butler_core::public_text::trim_js_whitespace(id).is_empty()
        || id.encode_utf16().count() > 4096
        || matches!(id, "." | "..")
        || id.contains(['/', '\\'])
    {
        return Err(invalid());
    }
    Ok(())
}

fn invalid() -> ProjectLedgerReadError {
    ProjectLedgerReadError::record_show("project_work_managed_record_invalid")
}
