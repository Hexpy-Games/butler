//! Source Work receipt: public control facts only, copied from raw fields.

use crate::{btcc::BtccError, json::visit_raw_array};

use super::{append_field, field};

pub(super) fn supports(name: &str) -> bool {
    crate::host::NativeGuidedWorkTools::is_work_tool(name)
}

pub(super) fn project_raw(name: &str, raw: &str) -> Result<String, BtccError> {
    let mut preview = String::from("{\"tool_name\":");
    crate::json::write_string(name, &mut preview).map_err(|_| {
        BtccError::new(
            "guided_tool_provider_serialization_failed",
            "Provider result JSON unavailable",
        )
    })?;
    for key in [
        "ok",
        "status",
        "authority_pending",
        "executed",
        "not_executed",
        "pending",
        "queued",
        "exit_code",
        "timed_out",
        "error",
    ] {
        if let Some(value) = field(raw, key)? {
            append_field(&mut preview, key, value)?;
        }
    }
    if let Some(work) = field(raw, "work")?.filter(|raw| raw.trim().starts_with('{')) {
        let mut public = String::from("{");
        for key in [
            "work_id",
            "status",
            "current_stage",
            "execution_mode",
            "allowed_next_stages",
            "unresolved_action_keys",
            "completion_blockers",
            "latest_plan_review",
            "latest_result_review",
            "latest_completion_validation",
            "latest_disposition",
        ] {
            if let Some(value) = field(work, key)? {
                if public.len() > 1 {
                    public.push(',');
                }
                crate::json::write_string(key, &mut public).map_err(|_| {
                    BtccError::new(
                        "guided_tool_provider_serialization_failed",
                        "Provider result JSON unavailable",
                    )
                })?;
                public.push(':');
                public.push_str(value);
            }
        }
        let mut actions = String::from("[");
        if let Some(raw_actions) = field(work, "actions")?.filter(|raw| raw.trim().starts_with('['))
        {
            visit_raw_array(raw_actions, |action| {
                if actions.len() > 1 {
                    actions.push(',');
                }
                let mut selected = String::from("{");
                for key in ["action_key", "status"] {
                    if let Some(value) = field(action, key)
                        .map_err(|e| crate::json::JsonError::new(e.to_string()))?
                    {
                        if selected.len() > 1 {
                            selected.push(',');
                        }
                        crate::json::write_string(key, &mut selected)?;
                        selected.push(':');
                        selected.push_str(value);
                    }
                }
                selected.push('}');
                actions.push_str(&selected);
                Ok(())
            })
            .map_err(|error| {
                BtccError::new(
                    "guided_tool_provider_serialization_failed",
                    error.to_string(),
                )
            })?;
        }
        actions.push(']');
        if public.len() > 1 {
            public.push(',');
        }
        public.push_str("\"actions\":");
        public.push_str(&actions);
        public.push('}');
        append_field(&mut preview, "work", &public)?;
    }
    preview.push('}');
    Ok(preview)
}
