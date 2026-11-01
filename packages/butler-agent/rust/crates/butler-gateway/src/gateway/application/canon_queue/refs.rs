//! Normalize canon epic references once, before queue authorization and validation.
use super::*;

pub(super) fn normalize(args: &mut Value) -> Result<(), GatewayApplicationError> {
    for key in ["epic_id", "target_epic_id"] {
        if let Some(value) = args.get_mut(key) {
            epic(value)?;
        }
    }
    for key in ["epic_ids", "steps"] {
        if let Some(values) = args[key].as_array_mut() {
            for value in values {
                if key == "steps" {
                    if let Some(step) = value.as_array_mut() {
                        for value in step {
                            epic(value)?;
                        }
                    }
                } else {
                    epic(value)?;
                }
            }
        }
    }
    Ok(())
}
fn epic(value: &mut Value) -> Result<(), GatewayApplicationError> {
    let Some(id) = value.as_str() else {
        return Ok(());
    };
    if let Some(id) = id.strip_prefix("canon:epic/").filter(|id| !id.is_empty()) {
        *value = json!(id);
    } else if id.starts_with("canon:") {
        return Err(public(
            400,
            "invalid_arguments",
            "An epic id or canon:epic/ ref is required.",
        ));
    }
    Ok(())
}
