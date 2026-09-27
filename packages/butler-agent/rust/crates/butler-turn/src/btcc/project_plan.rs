//! Accepted top-level Project Ledger Plan projection for Guided Turns.

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProjectLedgerPlan {
    pub id: String,
    pub title: String,
    pub status: String,
    pub body: String,
    pub path: Option<String>,
}

#[derive(Clone, Debug)]
pub struct ProjectLedgerPlanInput {
    pub id: String,
    pub title: String,
    pub status: String,
    pub body: Option<String>,
    pub path: Option<String>,
}

pub fn accepted_project_plan(
    input: &ProjectLedgerPlanInput,
    expected_id: &str,
) -> Option<ProjectLedgerPlan> {
    let id = butler_core::public_text::trim_js_whitespace(&input.id);
    let title = butler_core::public_text::trim_js_whitespace(&input.title);
    let body = butler_core::public_text::trim_js_whitespace(input.body.as_deref()?);
    let status = butler_core::public_text::trim_js_whitespace(&input.status);
    if id != expected_id || title.is_empty() || body.is_empty() {
        return None;
    }
    let status = if status.is_empty() { "draft" } else { status };
    if status != "active" {
        return None;
    }
    Some(ProjectLedgerPlan {
        id: id.to_owned(),
        title: title.to_owned(),
        status: status.to_owned(),
        body: body.to_owned(),
        path: input
            .path
            .as_deref()
            .map(butler_core::public_text::trim_js_whitespace)
            .filter(|path| !path.is_empty())
            .map(str::to_owned),
    })
}

pub fn render_accepted_project_plan(plan: &ProjectLedgerPlan) -> String {
    format!(
        "Accepted Project Ledger Plan:\n- id: {}\n- title: {}\n- status: active\n\n{}",
        plan.id, plan.title, plan.body
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn projection_retains_original_expected_id_and_active_only_policy() {
        let record = ProjectLedgerPlanInput {
            id: " PLAN-1 ".into(),
            title: "  Title  ".into(),
            status: "active".into(),
            body: Some("\nBody\n".into()),
            path: Some(" plan.md ".into()),
        };
        assert!(accepted_project_plan(&record.clone(), " PLAN-1 ").is_none());
        let plan = accepted_project_plan(&record.clone(), "PLAN-1").unwrap();
        assert_eq!(plan.path.as_deref(), Some("plan.md"));
        assert_eq!(
            render_accepted_project_plan(&plan),
            "Accepted Project Ledger Plan:\n- id: PLAN-1\n- title: Title\n- status: active\n\nBody"
        );
        assert!(
            accepted_project_plan(
                &ProjectLedgerPlanInput {
                    status: "closed".into(),
                    ..record
                },
                "PLAN-1"
            )
            .is_none()
        );
    }
}
