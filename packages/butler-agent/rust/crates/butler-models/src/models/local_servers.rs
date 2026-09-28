//! Detection of the local model servers first-run setup offers (#230):
//! Ollama (`GET /api/tags`, default port 11434) and LM Studio
//! (`GET /v1/models`, default port 1234). Each probe is short and
//! independent; a server that does not answer is listed as unreachable.

use std::time::Duration;

use futures_util::future::join_all;
use reqwest::{Client, redirect::Policy};
use serde::Serialize;
use serde_json::Value;

use super::LocalModelPlatform;

/// The local servers setup knows how to find.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LocalServerKind {
    Ollama,
    LmStudio,
}

impl LocalServerKind {
    pub const ALL: [Self; 2] = [Self::Ollama, Self::LmStudio];

    /// Where the server listens when its user did not change the port.
    pub fn default_base_url(self) -> &'static str {
        match self {
            Self::Ollama => "http://127.0.0.1:11434",
            Self::LmStudio => "http://127.0.0.1:1234",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Ollama => "Ollama",
            Self::LmStudio => "LM Studio",
        }
    }

    /// The platform a model of this server registers with.
    pub fn platform(self) -> LocalModelPlatform {
        match self {
            Self::Ollama => LocalModelPlatform::Ollama,
            Self::LmStudio => LocalModelPlatform::LmStudio,
        }
    }

    fn list_path(self) -> &'static str {
        match self {
            Self::Ollama => "/api/tags",
            Self::LmStudio => "/v1/models",
        }
    }
}

/// One server to probe.
#[derive(Clone, Debug)]
pub struct LocalServerProbe {
    pub kind: LocalServerKind,
    /// Server root without the `/v1` API suffix, e.g. `http://127.0.0.1:11434`.
    pub base_url: String,
}

/// A probed server and the chat models it offers.
#[derive(Clone, Debug, Serialize)]
pub struct DetectedLocalServer {
    pub id: LocalServerKind,
    pub label: &'static str,
    /// Passed as `server_url` to `POST /model-catalog/local-models`.
    pub base_url: String,
    pub reachable: bool,
    pub models: Vec<DetectedLocalModel>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct DetectedLocalModel {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
}

/// Probes every server at once; each probe is bounded by `timeout`.
pub async fn detect_local_servers(
    probes: &[LocalServerProbe],
    timeout: Duration,
) -> Vec<DetectedLocalServer> {
    // Loopback probes never go through a system proxy or follow redirects.
    let client = Client::builder()
        .no_proxy()
        .redirect(Policy::none())
        .timeout(timeout)
        .build()
        .ok();
    join_all(probes.iter().map(|probe| async {
        let models = match &client {
            Some(client) => list_models(client, probe).await,
            None => None,
        };
        DetectedLocalServer {
            id: probe.kind,
            label: probe.kind.label(),
            base_url: probe.base_url.trim_end_matches('/').to_owned(),
            reachable: models.is_some(),
            models: models.unwrap_or_default(),
        }
    }))
    .await
}

/// The server's chat models, or `None` when it did not answer as `kind`.
async fn list_models(client: &Client, probe: &LocalServerProbe) -> Option<Vec<DetectedLocalModel>> {
    let url = format!(
        "{}{}",
        probe.base_url.trim_end_matches('/'),
        probe.kind.list_path()
    );
    let response = client.get(url).send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    let body = serde_json::from_slice::<Value>(&response.bytes().await.ok()?).ok()?;
    match probe.kind {
        LocalServerKind::Ollama => ollama_models(&body),
        LocalServerKind::LmStudio => openai_models(&body),
    }
}

/// `GET /api/tags`: `{"models":[{"name","model","size","details":{"family"}}]}`.
pub(crate) fn ollama_models(body: &Value) -> Option<Vec<DetectedLocalModel>> {
    let models = body.get("models")?.as_array()?;
    Some(
        models
            .iter()
            .filter_map(|model| {
                let id = model
                    .get("model")
                    .or_else(|| model.get("name"))
                    .and_then(Value::as_str)?;
                let family = model
                    .pointer("/details/family")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                (!is_embedding(id) && !family.contains("bert")).then(|| DetectedLocalModel {
                    id: id.to_owned(),
                    size_bytes: model.get("size").and_then(Value::as_u64),
                })
            })
            .collect(),
    )
}

/// `GET /v1/models`: `{"object":"list","data":[{"id","object":"model"}]}`.
pub(crate) fn openai_models(body: &Value) -> Option<Vec<DetectedLocalModel>> {
    let models = body.get("data")?.as_array()?;
    Some(
        models
            .iter()
            .filter_map(|model| model.get("id").and_then(Value::as_str))
            .filter(|id| !is_embedding(id))
            .map(|id| DetectedLocalModel {
                id: id.to_owned(),
                size_bytes: None,
            })
            .collect(),
    )
}

/// Embedding models are listed by both servers but cannot chat.
fn is_embedding(id: &str) -> bool {
    id.to_ascii_lowercase().contains("embed")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    /// Shapes from the vendors' API references: Ollama docs/api.md "List
    /// Local Models" (ollama/ollama@7af3931) and the OpenAI list format LM
    /// Studio mirrors (lmstudio-ai/docs@d712bc9 gives no body example).
    #[test]
    fn reads_documented_list_shapes_and_skips_embedding_models() {
        let ollama = json!({"models":[
            {"name":"llama3.2:latest","model":"llama3.2:latest","size":2_019_393_189_u64,
             "details":{"format":"gguf","family":"llama"}},
            {"name":"nomic-embed-text:latest","model":"nomic-embed-text:latest","size":274_302_450,
             "details":{"format":"gguf","family":"nomic-bert"}}
        ]});
        assert_eq!(
            ollama_models(&ollama),
            Some(vec![DetectedLocalModel {
                id: "llama3.2:latest".into(),
                size_bytes: Some(2_019_393_189),
            }])
        );
        let lm_studio = json!({"object":"list","data":[
            {"id":"qwen3-8b","object":"model","owned_by":"organization_owner"},
            {"id":"text-embedding-nomic-embed-text-v1.5","object":"model","owned_by":"organization_owner"}
        ]});
        let ids: Vec<_> = openai_models(&lm_studio)
            .unwrap_or_default()
            .into_iter()
            .map(|model| model.id)
            .collect();
        assert_eq!(ids, ["qwen3-8b"]);
        assert_eq!(ollama_models(&json!({"data": []})), None);
    }
}
