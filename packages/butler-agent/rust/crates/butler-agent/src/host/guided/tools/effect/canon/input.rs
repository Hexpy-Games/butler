//! Resolve exact board identity and display facts before authority admission.
use super::*;
use chrono::Datelike;

pub(super) async fn resolve(owner: &GuidedTools, args: &Value) -> Result<Value, BtccError> {
    let kind = text(args, "kind")?;
    if !matches!(kind, "epic" | "plan") {
        return Err(invalid("kind must be epic or plan."));
    }
    let title = text(args, "title")?;
    let reference = text(args, "project_ref")?;
    let client = ScheduleClient::active(&owner.app_endpoint).map_err(|error| relay(&error))?;
    let project = resolve_project(&client, reference).await?;
    let project_id = project["id"]
        .as_str()
        .ok_or_else(|| invalid("Project identity unavailable."))?;
    let mut canon = json!({"kind":kind,"title":title,"project_id":project_id,
        "project_title":project["display_name"]});
    let mut body = json!({"title":title});
    if let Some(description) = args.get("description") {
        if !description.is_string() {
            return Err(invalid("description must be a string."));
        }
        body["description"] = description.clone();
        canon["description"] = description.clone();
    }
    if let Some(id) = args.get("plan_id").and_then(Value::as_str) {
        if kind != "epic" {
            return Err(invalid("plan_id is available for epics only."));
        }
        let plan = client
            .request(
                reqwest::Method::GET,
                &format!("/canon/plans/{}", segment(id)),
                None,
            )
            .await
            .map_err(|error| {
                if error.code() == "work_model_not_found" {
                    BtccError::relayed("canon_plan_not_found", "Plan not found in this project.")
                } else {
                    relay(&error)
                }
            })?;
        if plan["project_id"] != project_id {
            return Err(BtccError::relayed(
                "canon_plan_not_found",
                "Plan not found in this project.",
            ));
        }
        canon["plan_id"] = id.into();
        canon["plan_title"] = plan["title"].clone();
        body["plan_id"] = id.into();
    }
    if let Some(due) = args.get("due_on").and_then(Value::as_str) {
        if kind != "plan"
            || due.len() != 10
            || chrono::NaiveDate::parse_from_str(due, "%Y-%m-%d")
                .ok()
                .is_none_or(|date| date.year() <= 0 || date.format("%Y-%m-%d").to_string() != due)
        {
            return Err(invalid("Plan due_on must be YYYY-MM-DD."));
        }
        canon["due_on"] = due.into();
        body["due_on"] = due.into();
    }
    Ok(json!({"canon":canon,"body":body}))
}

fn text<'a>(input: &'a Value, key: &str) -> Result<&'a str, BtccError> {
    input[key]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| invalid(&format!("{key} is required.")))
}
fn invalid(message: &str) -> BtccError {
    BtccError::relayed("canon_propose_invalid", message)
}
fn relay(error: &crate::host::automation::client::ScheduleError) -> BtccError {
    BtccError::relayed(error.code().to_owned(), error.message().to_owned())
}
fn segment(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

async fn resolve_project(client: &ScheduleClient, reference: &str) -> Result<Value, BtccError> {
    let query: String = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("project_ref", reference)
        .finish();
    client
        .request(reqwest::Method::GET, &format!("/projects?{query}"), None)
        .await
        .map_err(|error| relay(&error))
}
