use super::{
    AdminClient, BtccError, GuidedTools, JsonDocument, ToolExecutionError, ToolName, admin,
    encoded, error, gateway_failure, mutation_view, not_found, rows,
};
use butler_models::models::CredentialError;
use http::Method;
use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;

pub(super) async fn claimed(
    owner: &GuidedTools,
    cancellation: &CancellationToken,
    tool: ToolName,
    request_ref: String,
    id: Option<String>,
    values: Map<String, Value>,
) -> Result<JsonDocument, ToolExecutionError> {
    let client = admin(owner).await;
    let authority = owner.authority.clone();
    let task = tokio::spawn(async move {
        if !authority
            .claim_question_apply(request_ref.clone())
            .await
            .map_err(|error| ToolExecutionError::Integrity(error.into()))?
        {
            return super::super::execute::uncertain_mutation(tool.as_str());
        }
        let result = match (client, tool, id) {
            (Err(error), _, _) => Err(error),
            (Ok(client), ToolName::ComputerAdd, _) => add(&client, values).await,
            (Ok(client), ToolName::ComputerEdit, Some(id)) => edit(&client, &id, values).await,
            (Ok(client), ToolName::ComputerRemove, Some(id)) => {
                remove(&client, &id, values["confirm"] == "remove:forget").await
            }
            _ => Err(error(
                "card_mismatch",
                "The stored computer card does not match this tool.",
            )),
        };
        authority
            .finish_question_apply(request_ref)
            .await
            .map_err(|error| ToolExecutionError::Integrity(error.into()))?;
        encoded(&result.unwrap_or_else(gateway_failure))
    });
    tokio::select! {
        () = cancellation.cancelled() => encoded(&json!({"ok":false,"status":"cancelled"})),
        result = task => result.map_err(|error| ToolExecutionError::Integrity(BtccError::relayed("computer_apply_failed", error.to_string())))?,
    }
}

async fn add(client: &AdminClient, mut values: Map<String, Value>) -> Result<Value, Value> {
    let model = values.remove("model").unwrap_or_default();
    if let Some(id) = model["key"].as_str() {
        let credentials = client.data(Method::GET, "/credentials", None).await?;
        if !rows(&credentials, "credentials")
            .iter()
            .any(|credential| credential["id"] == id)
        {
            let missing = CredentialError::NotFound;
            return Err(error(missing.code(), &missing.to_string()));
        }
    }
    let sign_in = (model == "chatgpt").then(|| json!({"open_sign_in":true}));
    values.insert("model_source".into(), model);
    let result = client
        .data(Method::POST, "/computers", Some(&Value::Object(values)))
        .await?;
    let computer = mutation_view(&result["computer"]);
    let id = computer["id"].as_str().ok_or_else(not_found)?;
    let start = client
        .data(
            Method::POST,
            &format!("/computers/{id}/start"),
            sign_in.as_ref(),
        )
        .await;
    let mut result = json!({"ok":true,"computer":computer});
    if let Err(error) = start {
        result["start_error"] = error;
    }
    Ok(result)
}

async fn edit(
    client: &AdminClient,
    id: &str,
    mut values: Map<String, Value>,
) -> Result<Value, Value> {
    let data = client.data(Method::GET, "/computers", None).await?;
    let computer = rows(&data, "computers")
        .iter()
        .find(|computer| computer["id"] == id)
        .ok_or_else(not_found)?;
    let path = format!("/computers/{id}");
    let model = values.remove("model");
    let sign_in = model.as_ref().is_some_and(|model| *model == "chatgpt")
        && (computer["model_source"] != "chatgpt" || computer["ai_connected"] == false);
    let (method, mut body) = if values.is_empty() {
        (Method::PATCH, json!({"model_source": model}))
    } else {
        let mut body = json!({
            "name":computer["name"], "address":computer["address"], "port":computer["port"],
            "key_file":computer["key_file"], "folder":computer["folder"], "model_source":computer["model_source"],
        });
        for (field, value) in values {
            body[field] = value;
        }
        if let Some(model) = model {
            body["model_source"] = model;
        }
        (Method::PUT, body)
    };
    if sign_in {
        body["open_sign_in"] = json!(true);
    }
    let data = client.data(method, &path, Some(&body)).await?;
    Ok(json!({"computer":mutation_view(&data["computer"])}))
}

async fn remove(client: &AdminClient, id: &str, forget: bool) -> Result<Value, Value> {
    let mut data = client
        .data(Method::DELETE, &format!("/computers/{id}"), None)
        .await?;
    if forget && let Err(error) = reset_memory(client, id).await {
        data["memory_reset_error"] = error;
    }
    Ok(data)
}

async fn reset_memory(client: &AdminClient, id: &str) -> Result<Value, Value> {
    let inventory = client.data(Method::GET, "/memory/inventory", None).await?;
    let body =
        json!({"operation_id":uuid::Uuid::new_v4(),"inventory_revision":inventory["revision"]});
    client
        .data(
            Method::POST,
            &format!("/memory/reset/computers/{id}"),
            Some(&body),
        )
        .await
}
