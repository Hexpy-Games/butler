//! Per-protocol image discovery; missing evidence stays unknown.
use super::{fetch_object, model_props};
use crate::models::{LocalImageDiscovery, LocalModelPlatform};
use serde_json::{Value, json};

pub(crate) async fn probe(
    client: &butler_log::http::Client,
    api_base: &str,
    id: &str,
    platform: LocalModelPlatform,
    key: Option<&str>,
) -> Option<LocalImageDiscovery> {
    let root = api_base.strip_suffix("/v1").unwrap_or(api_base);
    let props = model_props(client, root, id, platform, key).await;
    if let Some(result) = native(client, root, id, platform, key, props.as_ref()).await {
        return Some(result);
    }
    let models = fetch_object(client, &format!("{api_base}/models"), key).await?;
    let entry = models
        .get("data")
        .or_else(|| models.get("models"))?
        .as_array()?
        .iter()
        .find(|model| {
            model
                .get("id")
                .or_else(|| model.get("model"))
                .and_then(Value::as_str)
                == Some(id)
        })?;
    explicit(entry)
}

pub(super) async fn native(
    client: &butler_log::http::Client,
    root: &str,
    id: &str,
    platform: LocalModelPlatform,
    key: Option<&str>,
    props: Option<&Value>,
) -> Option<LocalImageDiscovery> {
    let supported = match platform {
        LocalModelPlatform::Ollama => {
            let request = client
                .post(format!("{root}/api/show"))
                .json(&json!({"model":id}));
            let value = super::fetch_request(request, key).await?;
            value
                .get("capabilities")?
                .as_array()?
                .iter()
                .any(|v| v.as_str() == Some("vision"))
        }
        LocalModelPlatform::LmStudio => {
            let id: String = url::form_urlencoded::byte_serialize(id.as_bytes()).collect();
            let value = fetch_object(client, &format!("{root}/api/v0/models/{id}"), key).await?;
            match value.get("type")?.as_str()? {
                "vlm" => true,
                "llm" => false,
                _ => return None,
            }
        }
        LocalModelPlatform::LlamaCpp => props?.pointer("/modalities/vision")?.as_bool()?,
        LocalModelPlatform::Custom => return None,
    };
    Some(record(supported))
}

pub(super) fn explicit(value: &Value) -> Option<LocalImageDiscovery> {
    ["capabilities", "modalities", "input_modalities"]
        .iter()
        .any(|field| {
            let value = &value[*field];
            value
                .as_array()
                .or_else(|| value.get("input").and_then(Value::as_array))
                .is_some_and(|values| {
                    values
                        .iter()
                        .any(|v| matches!(v.as_str(), Some("image" | "vision")))
                })
        })
        .then(|| record(true))
}

fn record(supported: bool) -> LocalImageDiscovery {
    LocalImageDiscovery {
        supported,
        verified_at: chrono::Utc::now().to_rfc3339(),
    }
}
