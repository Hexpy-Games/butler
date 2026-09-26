//! Caller-cancelled discovery of user-managed local model servers.

use serde_json::Value;
use url::Url;

use crate::models::{
    LocalModelConfig, LocalModelPlatform, LocalModelSource, ModelCatalogError,
    ModelProviderMetadata, TokenEstimatorKind,
};

const DEFAULT_CONTEXT: f64 = 16_384.0;
const SOURCE_URL: &str = "https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md";

#[derive(Clone)]
pub(crate) struct DiscoveredLocalModel {
    pub provider_id: &'static str,
    pub provider_label: &'static str,
    pub model_id: String,
    pub model_ref: String,
    pub display_name: String,
    pub api_type: &'static str,
    pub platform: LocalModelPlatform,
    pub server_url: String,
    pub api_base_url: String,
    pub context_window_tokens: f64,
    pub max_output_tokens: Option<f64>,
    pub reasoning_budget_ratio: Option<f64>,
    pub source_url: &'static str,
    pub runtime_supported: bool,
}

pub(crate) struct LocalModelDiscoveryResult {
    pub server_url: String,
    pub api_base_url: String,
    pub api_type: &'static str,
    pub platform: LocalModelPlatform,
    pub models: Vec<DiscoveredLocalModel>,
}

impl From<&DiscoveredLocalModel> for ModelProviderMetadata {
    fn from(model: &DiscoveredLocalModel) -> Self {
        let config = LocalModelConfig {
            provider_id: model.provider_id.into(),
            provider_label: model.provider_label.into(),
            model_id: model.model_id.clone(),
            model_ref: model.model_ref.clone(),
            display_name: model.display_name.clone(),
            api_type: model.api_type.into(),
            platform: model.platform,
            server_url: model.server_url.clone(),
            api_base_url: model.api_base_url.clone(),
            context_window_tokens: model.context_window_tokens,
            max_output_tokens: model.max_output_tokens,
            reasoning_budget_ratio: model.reasoning_budget_ratio,
            token_estimator: TokenEstimatorKind::CharacterEstimate,
            source: LocalModelSource::Discovered,
            source_url: model.source_url.into(),
            runtime_supported: model.runtime_supported,
            created_at: String::new(),
            updated_at: String::new(),
            extensions: serde_json::Map::new(),
        };
        Self::from(&config)
    }
}

pub(super) async fn discover(
    client: &reqwest::Client,
    server_url: &str,
    platform: LocalModelPlatform,
    api_key: Option<&str>,
) -> Result<LocalModelDiscoveryResult, ModelCatalogError> {
    if api_key.is_some_and(|value| {
        value
            .chars()
            .any(|character| matches!(character, '\r' | '\n'))
    }) {
        return Err(error("Local model API key is invalid."));
    }
    let (server_url, api_base_url) = normalize_server(server_url)?;
    let server_root = api_base_url.strip_suffix("/v1").unwrap_or(&api_base_url);
    let models = fetch_object(client, &format!("{api_base_url}/models"), api_key)
        .await
        .and_then(|value| {
            value
                .get("data")
                .and_then(Value::as_array)
                .or_else(|| value.get("models").and_then(Value::as_array))
                .cloned()
        })
        .unwrap_or_default();
    if models.is_empty() {
        return Err(error(
            "Local model server did not return any models from /v1/models.",
        ));
    }
    let mut output = Vec::new();
    for model in models {
        let Some(object) = model.as_object() else {
            continue;
        };
        let raw_id = object
            .get("id")
            .and_then(Value::as_str)
            .or_else(|| object.get("model").and_then(Value::as_str))
            .unwrap_or("");
        if crate::public_text::trim_js_whitespace(raw_id).is_empty() {
            continue;
        }
        let props = if platform == LocalModelPlatform::LlamaCpp {
            let props_url = format!(
                "{server_root}/props?model={}",
                url::form_urlencoded::byte_serialize(raw_id.as_bytes()).collect::<String>()
            );
            match fetch_object(client, &props_url, api_key).await {
                Some(value) => Some(value),
                None => fetch_object(client, &format!("{server_root}/props"), api_key).await,
            }
        } else {
            None
        };
        let model_id = crate::public_text::trim_js_whitespace(raw_id);
        let context = props
            .as_ref()
            .and_then(context_from_props)
            .or_else(|| context_from_model(&model))
            .unwrap_or(DEFAULT_CONTEXT);
        output.push(DiscoveredLocalModel {
            provider_id: "local",
            provider_label: "Custom",
            display_name: display_name(model_id),
            model_ref: format!("local/{}", safe_model_id(model_id)),
            model_id: model_id.to_owned(),
            api_type: "openai_compatible",
            platform,
            server_url: server_url.clone(),
            api_base_url: api_base_url.clone(),
            context_window_tokens: context,
            max_output_tokens: None,
            reasoning_budget_ratio: None,
            source_url: SOURCE_URL,
            runtime_supported: true,
        });
    }
    if output.is_empty() {
        return Err(error(
            "Local model discovery returned only unsupported model records.",
        ));
    }
    Ok(LocalModelDiscoveryResult {
        server_url,
        api_base_url,
        api_type: "openai_compatible",
        platform,
        models: output,
    })
}

async fn fetch_object(client: &reqwest::Client, url: &str, api_key: Option<&str>) -> Option<Value> {
    let mut request = client.get(url);
    if let Some(api_key) = api_key.filter(|value| !value.is_empty()) {
        request = request.bearer_auth(api_key);
    }
    let response = request.send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    let bytes = response.bytes().await.ok()?;
    serde_json::from_slice::<Value>(&bytes)
        .ok()
        .filter(Value::is_object)
}

pub(super) fn normalize_server(value: &str) -> Result<(String, String), ModelCatalogError> {
    let value = crate::public_text::trim_js_whitespace(value);
    if value.is_empty() {
        return Err(error("Local model server URL is required."));
    }
    let candidate = if has_scheme(value) {
        value.to_owned()
    } else {
        format!("http://{value}")
    };
    let mut url =
        Url::parse(&candidate).map_err(|_| error("Local model server URL is invalid."))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(error("Local model server URL must use http or https."));
    }
    if url.host_str().is_none() {
        return Err(error("Local model server URL must include a host."));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(error(
            "Local model server URL must not include credentials.",
        ));
    }
    url.set_query(None);
    url.set_fragment(None);
    let path = url.path().trim_end_matches('/').to_owned();
    url.set_path(&path);
    let server = url.as_str().trim_end_matches('/').to_owned();
    let api = if url.path().trim_matches('/').is_empty() {
        format!("{server}/v1")
    } else {
        server.clone()
    };
    Ok((server, api))
}

fn has_scheme(value: &str) -> bool {
    let Some(index) = value.find("://") else {
        return false;
    };
    let scheme = &value[..index];
    !scheme.is_empty()
        && scheme.bytes().enumerate().all(|(i, byte)| {
            byte.is_ascii_alphabetic()
                || (i > 0 && (byte.is_ascii_digit() || matches!(byte, b'+' | b'.' | b'-')))
        })
}

fn context_from_props(value: &Value) -> Option<f64> {
    [
        "/default_generation_settings/n_ctx",
        "/default_generation_settings/params/n_ctx",
        "/n_ctx",
        "/model_meta/n_ctx",
        "/model_meta/n_ctx_train",
    ]
    .into_iter()
    .find_map(|path| positive(value.pointer(path)))
}

fn context_from_model(value: &Value) -> Option<f64> {
    positive(value.pointer("/meta/n_ctx"))
        .or_else(|| context_from_args(value.pointer("/status/args")))
        .or_else(|| positive(value.pointer("/meta/n_ctx_train")))
        .or_else(|| positive(value.get("max_model_len")))
        .or_else(|| positive(value.get("max_context_len")))
        .or_else(|| positive(value.get("context_length")))
}

fn context_from_args(value: Option<&Value>) -> Option<f64> {
    let args = value?.as_array()?;
    args.windows(2).find_map(|pair| {
        matches!(pair[0].as_str(), Some("-ctx" | "--ctx-size" | "-c"))
            .then(|| {
                pair[1]
                    .as_str()
                    .map(crate::json::number_from_string)
                    .filter(|value| value.is_finite() && *value > 0.0)
                    .map(f64::trunc)
            })
            .flatten()
    })
}

fn positive(value: Option<&Value>) -> Option<f64> {
    positive_number(value?.as_f64()?)
}
fn positive_number(value: f64) -> Option<f64> {
    (value.is_finite() && value.trunc() > 0.0).then(|| value.trunc())
}

fn safe_model_id(value: &str) -> String {
    let value = crate::public_text::trim_js_whitespace(value)
        .strip_prefix("local/")
        .unwrap_or(value);
    let mut output = String::new();
    let mut hyphen = false;
    for character in value.chars().filter(|c| !c.is_control()) {
        if character == '/' || character == '\\' || is_js_space(character) {
            if !hyphen {
                output.push('-');
                hyphen = true;
            }
        } else {
            output.push(character);
            hyphen = false;
        }
    }
    let output = output.trim_matches('/').to_owned();
    if output.is_empty() {
        "local-model".into()
    } else {
        output
    }
}

fn display_name(id: &str) -> String {
    let lower = id.to_ascii_lowercase();
    let value = [".safetensors", ".gguf", ".bin"]
        .into_iter()
        .find(|suffix| lower.ends_with(suffix))
        .map_or(id, |suffix| &id[..id.len() - suffix.len()]);
    let mut replaced = String::new();
    let mut separator = false;
    for character in value.chars() {
        if matches!(character, '-' | '_') {
            if !separator {
                replaced.push(' ');
                separator = true;
            }
        } else {
            replaced.push(character);
            separator = false;
        }
    }
    let value = crate::public_text::trim_js_whitespace(&replaced);
    if value.is_empty() {
        id.into()
    } else {
        value.into()
    }
}

fn is_js_space(value: char) -> bool {
    matches!(value, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}'
        | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}'
        | '\u{3000}' | '\u{feff}')
}

fn error(message: &str) -> ModelCatalogError {
    ModelCatalogError::new(format!("local_model_discovery_failed: {message}"))
}

#[cfg(test)]
mod tests {
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    use super::*;

    #[tokio::test]
    async fn loopback_discovery_uses_models_and_per_model_props_with_fallbacks() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let mut paths = Vec::new();
            let mut authenticated = Vec::new();
            for _ in 0..5 {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = vec![0; 4096];
                let size = stream.read(&mut request).await.unwrap();
                let request = String::from_utf8_lossy(&request[..size]);
                let path = request.split_whitespace().nth(1).unwrap().to_owned();
                authenticated.push(
                    request
                        .to_ascii_lowercase()
                        .contains("authorization: bearer discovery-key"),
                );
                let body = if path == "/v1/models" {
                    r#"{"data":[{"id":"model-one.gguf"},{"model":"model-two","context_length":4096},{"id":"fractional","status":{"args":["--ctx-size","0.5"]},"context_length":4096},{"id":"binary","status":{"args":["-c","0b1000"]}}]}"#
                } else if path.contains("model-one.gguf") {
                    r#"{"default_generation_settings":{"n_ctx":32768}}"#
                } else {
                    "{}"
                };
                paths.push(path);
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                stream.write_all(response.as_bytes()).await.unwrap();
            }
            (paths, authenticated)
        });
        let result = discover(
            &crate::models::provider_http_client().unwrap(),
            &address.to_string(),
            LocalModelPlatform::LlamaCpp,
            Some("discovery-key"),
        )
        .await
        .unwrap();
        assert_eq!(result.server_url, format!("http://{address}"));
        assert_eq!(result.models[0].model_id, "model-one.gguf");
        assert_eq!(result.models[0].display_name, "model one");
        assert_eq!(result.models[0].context_window_tokens, 32_768.0);
        assert_eq!(result.models[1].context_window_tokens, 4_096.0);
        assert_eq!(result.models[2].context_window_tokens, 0.0);
        assert_eq!(result.models[3].context_window_tokens, 8.0);
        let (paths, authenticated) = server.await.unwrap();
        assert_eq!(paths[0], "/v1/models");
        assert!(paths[1].starts_with("/props?model=model-one.gguf"));
        assert!(paths[2].starts_with("/props?model=model-two"));
        assert!(authenticated.into_iter().all(|value| value));
        assert_eq!(result.models[0].provider_label, "Custom");
    }

    #[tokio::test]
    async fn fetch_object_accepts_response_larger_than_four_megabytes() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let body = serde_json::json!({"padding":"x".repeat(4 * 1024 * 1024 + 1)}).to_string();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0; 1024];
            assert!(stream.read(&mut request).await.unwrap() > 0);
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(response.as_bytes()).await.unwrap();
        });
        let value = fetch_object(
            &crate::models::provider_http_client().unwrap(),
            &format!("http://{address}/large"),
            None,
        )
        .await
        .unwrap();
        server.await.unwrap();
        assert_eq!(
            value["padding"].as_str().map(str::len),
            Some(4 * 1024 * 1024 + 1)
        );
    }

    #[tokio::test]
    async fn custom_discovery_preserves_raw_ids_and_skips_llama_props() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0; 1024];
            let size = stream.read(&mut request).await.unwrap();
            let request = String::from_utf8_lossy(&request[..size]);
            assert!(request.starts_with("GET /gateway/v1/models HTTP/1.1\r\n"));
            assert!(
                request
                    .to_ascii_lowercase()
                    .contains("authorization: bearer custom-key")
            );
            let body = r#"{"data":[{"id":"org/model.gguf","context_length":8192}]}"#;
            stream
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        });
        let result = discover(
            &crate::models::provider_http_client().unwrap(),
            &format!("http://{address}/gateway/v1/"),
            LocalModelPlatform::Custom,
            Some("custom-key"),
        )
        .await
        .unwrap();
        server.await.unwrap();
        assert_eq!(result.api_base_url, format!("http://{address}/gateway/v1"));
        assert_eq!(result.models[0].model_id, "org/model.gguf");
        assert_eq!(result.models[0].model_ref, "local/org-model.gguf");
        assert_eq!(result.models[0].context_window_tokens, 8_192.0);
    }
}
