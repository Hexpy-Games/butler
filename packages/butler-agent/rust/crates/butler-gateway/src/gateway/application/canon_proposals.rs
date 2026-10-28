//! App identities and attachments surround the independent canon transaction.
mod projects;
pub(super) use projects::recover;
mod read;
use super::*;
pub(super) use read::language;
use serde_json::json;

pub(super) async fn execute(
    app: &AppApplication,
    action: &str,
    input: Value,
) -> Result<Value, GatewayApplicationError> {
    match action {
        "get" => read::detail(app, field(&input, "id")?).await,
        "read" => read::canon_read(app, input).await,
        "propose" => propose(app, input).await,
        "resolve" => resolve(app, input).await,
        _ => Err(public(400, "invalid_arguments", "Unknown canon operation.")),
    }
}
async fn propose(app: &AppApplication, input: Value) -> Result<Value, GatewayApplicationError> {
    let session = field(&input, "session_id")?;
    let owner = app.runtime_hint(&session).await?;
    let mut args = input["arguments"].clone();
    let summary = field(&args, "summary")?;
    let project = read::target_project(app, &session, args["project_id"].as_str()).await?;
    let mut changes = args["changes"]
        .as_array()
        .cloned()
        .ok_or_else(|| public(400, "invalid_arguments", "changes required"))?;
    let files = app.canon_file_lifetimes.lock().await;
    read::attachments(app, &session, &mut changes).await?;
    let new_name = changes
        .iter()
        .find(|c| c["op"] == "project.create")
        .and_then(|c| c["name"].as_str())
        .map(str::to_owned);
    if let Some(name) = &new_name {
        super::projects::validate_branch_name(name)?;
    }
    args["changes"] = json!(changes);
    args["new_name"] = json!(new_name);
    let id = app.dependencies.identity_clock.new_uuid();
    let result = app
        .dependencies
        .canon
        .proposal(
            "create".into(),
            json!({"id":id,"session_id":owner,
        "source_turn_id":input["turn_id"],"source_call_id":input["call_id"],"project_id":project,
        "summary":summary,"document":args,"created_at":app.dependencies.identity_clock.now_iso()}),
        )
        .await?;
    if input["apply"] == true && result["ok"] == true {
        drop(files);
        return resolve(app, json!({"id":id,"outcome":"accepted","by":null})).await;
    }
    Ok(result)
}
pub(super) async fn resolve(
    app: &AppApplication,
    input: Value,
) -> Result<Value, GatewayApplicationError> {
    let id = field(&input, "id")?;
    let _serial = app
        .canon_projection_locks
        .acquire(format!("proposal:{id}"))
        .await;
    let mut row = app
        .dependencies
        .canon
        .proposal("raw".into(), json!({"id":id}))
        .await?;
    if let Some(session) = input["session_id"].as_str() {
        let owner = app.runtime_hint(session).await?;
        if row["session_id"] != owner {
            return Err(public(404, "ask_not_found", "Open proposal not found."));
        }
    }
    let by = input.get("by").cloned().unwrap_or(json!("card"));
    if matches!(
        input["outcome"].as_str(),
        Some("declined" | "dropped" | "dismiss")
    ) {
        let row = app
            .dependencies
            .canon
            .proposal("cancel".into(), json!({"id":id,"by":by}))
            .await?;
        return Ok(json!({"ok":true,"ask_id":format!("canon:{id}"),"state":row["state"]}));
    }
    if input["outcome"] != "accepted" {
        return Err(public(400, "invalid_outcome", "Use accepted or declined."));
    }
    if row["state"] == "applied" {
        return Ok(row["document"]["result"].clone());
    }
    if row["state"] != "open" {
        return Err(public(
            409,
            "ask_not_open",
            "This proposal is no longer open.",
        ));
    }
    if input.get("project_id").is_some() || input.get("new_name").is_some() {
        if let Some(name) = input["new_name"].as_str() {
            super::projects::validate_branch_name(name)?;
        }
        row = app
            .dependencies
            .canon
            .proposal(
                "select".into(),
                json!({"id":id,"project_id":input["project_id"],"new_name":input["new_name"]}),
            )
            .await?;
    }
    let _files = app.canon_file_lifetimes.lock().await;
    let project = projects::prepare(app, &id, &row, by.as_str()).await?;
    #[cfg(feature = "e2e-fixtures")]
    super::canon::hold(app, "canon_write").await?;
    let result = app
        .dependencies
        .canon
        .proposal(
            "apply".into(),
            json!({"id":id,"project_id":project,"by":by}),
        )
        .await;
    let applied = result.as_ref().is_ok_and(|r| r["ok"] == true);
    #[cfg(feature = "e2e-fixtures")]
    if applied {
        super::canon::hold(app, "canon_project_publish").await?;
    }
    projects::finish(app, &id, applied).await?;
    result
}
fn field(input: &Value, key: &str) -> Result<String, GatewayApplicationError> {
    input[key]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| public(400, "invalid_arguments", &format!("{key} required")))
}
fn public(status: u16, code: &str, message: &str) -> GatewayApplicationError {
    GatewayApplicationError::Public {
        status,
        code: code.into(),
        message: message.into(),
        source: None,
    }
}
