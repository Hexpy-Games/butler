use serde_json::{Value, json};

use crate::skills::{NativeSkills, SkillValidationIssue};

use super::{CapabilityError, CapabilityInvocation};

pub(super) fn definition() -> Value {
    json!({
        "type":"function",
        "name":"list_skills",
        "description":"List Butler's machine-readable strategy skills, applicability notes, allowed tools, dispatch preference, review requirement, and validation issues. Selected installed native skills also expose their installation-bound commands and instructions.",
        "parameters":{"type":"object","additionalProperties":false,"properties":{},"required":[]},
        "effectBoundary":"none",
        "concurrencySafe":true,
        "interruptBehavior":"continue",
        "transcriptVisibility":"visible"
    })
}

pub(super) async fn execute(
    skills: &NativeSkills,
    input: CapabilityInvocation<'_>,
) -> Result<Value, CapabilityError> {
    let project_id = input
        .call
        .get("projectId")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let catalog = skills
        .runtime_catalog(project_id)
        .await
        .map_err(|error| CapabilityError {
            code: error.code().into(),
        })?;
    let issues: Vec<SkillValidationIssue> = crate::skills::validate(&catalog);
    let projected: Vec<Value> = catalog
        .into_iter()
        .map(|skill| {
            let mut value = json!({
                "name":skill.name,"description":skill.description,"applicability":skill.applicability,
                "allowed_tools":skill.allowed_tools,"dispatch":skill.dispatch,"review":skill.review,
                "reporting":skill.reporting,"user_invocable":skill.user_invocable
            });
            if let Some(command) = skill.native_command {
                value["native_command"] = json!(command);
                value["instructions"] = json!(skill.instructions);
            }
            if let Some(command) = skill.native_context_command {
                value["native_context_command"] = json!(command);
            }
            value
        })
        .collect();
    Ok(json!({"ok":true,"skills":projected,"validation_issues":issues}))
}
