//! `app/setupProviders.ts`: the local model servers the Agent found, and the models of a typed
//! server address, as the options the model pickers list.
use std::rc::Rc;

use gpui::SharedString;
use serde_json::Value;

/// A model on a local server or a typed server address (`LocalModelOption`).
#[derive(Clone, Debug)]
pub(crate) struct LocalModelOption {
    pub(crate) key: SharedString,
    pub(crate) model_id: SharedString,
    /// `ollama`, `lm_studio` or `custom`.
    pub(crate) platform: SharedString,
    pub(crate) server_url: SharedString,
    pub(crate) size_label: Option<SharedString>,
    pub(crate) context_window_tokens: Option<u64>,
    pub(crate) source_model: Option<Rc<Value>>,
}

/// `LocalModelServerView`: an entry of `GET /setup/local-model-servers`.
#[derive(Clone, Debug, PartialEq)]
pub(super) struct Server {
    pub(super) id: String,
    pub(super) label: String,
    pub(super) base_url: String,
    pub(super) reachable: bool,
    /// (model id, size in bytes)
    pub(super) models: Vec<(String, Option<f64>)>,
}

/// `fetchLocalModelServers`: the `servers` array, or none.
pub(super) fn parse_servers(reply: &Value) -> Vec<Server> {
    let text = |value: &Value, key: &str| {
        value
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    let Some(servers) = reply.get("servers").and_then(Value::as_array) else {
        return Vec::new();
    };
    servers
        .iter()
        .map(|server| Server {
            id: text(server, "id"),
            label: text(server, "label"),
            base_url: text(server, "base_url"),
            reachable: server
                .get("reachable")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            models: server
                .get("models")
                .and_then(Value::as_array)
                .map(|models| {
                    models
                        .iter()
                        .map(|model| {
                            (
                                text(model, "id"),
                                model.get("size_bytes").and_then(Value::as_f64),
                            )
                        })
                        .collect()
                })
                .unwrap_or_default(),
        })
        .collect()
}

fn platform_of(server_id: &str) -> &'static str {
    match server_id {
        "ollama" => "ollama",
        "lm_studio" => "lm_studio",
        _ => "custom",
    }
}

fn size_label(bytes: Option<f64>) -> Option<SharedString> {
    let bytes = bytes.filter(|bytes| *bytes > 0.)?;
    Some(if bytes >= 1e9 {
        format!("{:.1} GB", bytes / 1e9).into()
    } else {
        format!("{} MB", (bytes / 1e6).round().max(1.)).into()
    })
}

/// `localModelOptions`: every model of every reachable server, in server order.
pub(super) fn model_options(servers: &[Server]) -> Vec<LocalModelOption> {
    servers
        .iter()
        .filter(|server| server.reachable)
        .flat_map(|server| {
            server.models.iter().map(|(id, bytes)| LocalModelOption {
                key: format!("{}/{id}", server.id).into(),
                model_id: id.clone().into(),
                platform: platform_of(&server.id).into(),
                server_url: server.base_url.clone().into(),
                size_label: size_label(*bytes),
                context_window_tokens: None,
                source_model: None,
            })
        })
        .collect()
}

/// `knownContextWindow`: a usable context size, or none (discovery reports 0 for unknown).
fn known_context_window(tokens: Option<u64>) -> Option<u64> {
    tokens.filter(|tokens| *tokens > 0)
}

/// `customModelOptions`: the models found through a typed server address (Other).
pub(crate) fn custom_model_options(server_url: &str, models: &[Value]) -> Vec<LocalModelOption> {
    models
        .iter()
        .filter_map(|model| {
            let text = |key: &str| model.get(key).and_then(Value::as_str);
            Some(LocalModelOption {
                key: text("model_ref")?.to_owned().into(),
                model_id: text("model_id")?.to_owned().into(),
                platform: "custom".into(),
                server_url: server_url.to_owned().into(),
                size_label: None,
                context_window_tokens: known_context_window(
                    model.get("context_window_tokens").and_then(Value::as_u64),
                ),
                source_model: Some(Rc::new(model.clone())),
            })
        })
        .collect()
}
