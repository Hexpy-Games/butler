use serde_json::{Value, json};

use crate::skills::{SkillDefinition, SkillValidationIssue, Skills};

use super::{CapabilityError, CapabilityInvocation};

pub(super) fn definition() -> Value {
    json!({
        "type":"function",
        "name":"list_skills",
        "description":"List Butler's machine-readable strategy skills, applicability notes, allowed tools, dispatch preference, review requirement, and validation issues. When a listed skill applies, call again with its name to read its instructions before following it. Selected installed native skills also expose their installation-bound commands and instructions.",
        "parameters":{"type":"object","additionalProperties":false,"properties":{
            "name":{"type":"string","description":"A listed skill's name: the result then holds only that skill, with its full instructions."}
        },"required":[]},
        "effectBoundary":"none",
        "concurrencySafe":true,
        "interruptBehavior":"continue",
        "transcriptVisibility":"visible"
    })
}

/// Every skill's metadata, or with `name` that skill with its instructions
/// (an unknown name is a `skill_not_found` naming the loaded skills).
pub(super) async fn execute(
    skills: &Skills,
    input: CapabilityInvocation<'_>,
) -> Result<Value, CapabilityError> {
    let project_id = input
        .call
        .get("projectId")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let name = input
        .call
        .get("arguments")
        .and_then(|arguments| arguments.get("name"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty());
    let catalog = skills
        .runtime_catalog(project_id)
        .await
        .map_err(|error| CapabilityError::caused(error.code(), error))?;
    let issues: Vec<SkillValidationIssue> = crate::skills::validate(&catalog);
    let Some(name) = name else {
        let projected: Vec<Value> = catalog
            .into_iter()
            .map(|skill| project(skill, false))
            .collect();
        return Ok(json!({"ok":true,"skills":projected,"validation_issues":issues}));
    };
    let names: Vec<String> = catalog.iter().map(|skill| skill.name.clone()).collect();
    let named: Vec<SkillDefinition> = catalog
        .into_iter()
        .filter(|skill| skill.name == name)
        .collect();
    if named.is_empty() {
        let message = format!(
            "No loaded skill is named {name}. Use a name from allowed, or call list_skills \
             without a name to see every skill."
        );
        return Ok(json!({"ok":false,"error":{
            "code":"skill_not_found","message":message,"field":"name","allowed":names
        }}));
    }
    let files: Vec<String> = named
        .iter()
        .map(|skill| skill.file_path.to_string_lossy().into_owned())
        .collect();
    let issues: Vec<_> = issues
        .into_iter()
        .filter(|issue| files.contains(&issue.file_path))
        .collect();
    let projected: Vec<Value> = named
        .into_iter()
        .map(|skill| project(skill, true))
        .collect();
    Ok(json!({"ok":true,"skills":projected,"validation_issues":issues}))
}

/// A skill's model-facing entry; its instructions when `instructions` is set
/// or when it is an installed native skill.
fn project(skill: SkillDefinition, instructions: bool) -> Value {
    let mut value = json!({
        "name":skill.name,"description":skill.description,"applicability":skill.applicability,
        "allowed_tools":skill.allowed_tools,"dispatch":skill.dispatch,"review":skill.review,
        "reporting":skill.reporting,"user_invocable":skill.user_invocable
    });
    if let Some(command) = skill.native_command {
        value["native_command"] = json!(command);
        value["instructions"] = json!(skill.instructions);
    }
    if instructions {
        value["instructions"] = json!(skill.instructions);
    }
    if let Some(command) = skill.native_context_command {
        value["native_context_command"] = json!(command);
    }
    value
}
