use butler_models::models::*;
use butler_turn::btcc::{ModelRoundError, ProviderRequestError};
use serde_json::json;
use std::{sync::Arc, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
use url::Url;

pub(super) struct Config {
    pub endpoint: Url,
    pub snapshot: Arc<ModelCatalogSnapshot>,
}
impl ProviderRequestConfigPort for Config {
    fn effective_prompt_model(&self, requested: Option<&str>) -> Result<String, ModelRoundError> {
        requested
            .map(str::to_owned)
            .ok_or_else(|| ModelRoundError::InvocationFailure {
                code: Some("offline_model_required".into()),
                message: "Replay requires an explicit model.".into(),
            })
    }
    fn sizing_snapshot(
        &self,
        _: Option<&str>,
    ) -> Result<Arc<ModelCatalogSnapshot>, ModelRoundError> {
        Ok(self.snapshot.clone())
    }
    fn resolve<'a>(&'a self, request: ProviderConfigRequest<'a>) -> ProviderConfigFuture<'a> {
        Box::pin(async move {
            let metadata = self
                .snapshot
                .resolve_model_metadata(Some(request.model_ref));
            Ok(ProviderRequestConfig {
                wire_model: metadata.model_id.clone(),
                api_shape: metadata.hosted_api_shape,
                metadata,
                endpoint: self.endpoint.clone(),
                auth: ProviderAuth::Codex {
                    mode: ProviderAuthMode::CodexSubscription,
                    authorization: "Bearer offline-stub".into(),
                    account_id: "offline".into(),
                    user_agent: "offline".into(),
                    originator: "butler".into(),
                },
                policy: ProviderRoundPolicy {
                    total: Duration::from_secs(10),
                    idle: None,
                    retry_base_ms: 0.0,
                },
                retry_attempts: 1.0,
                prompt_cache: ProviderPromptCachePolicy {
                    key_prefix: Some("offline".into()),
                    retention: None,
                },
                prompt_reasoning_effort: None,
            })
        })
    }
}
pub(super) struct Observer;
impl ProviderObservationSink for Observer {
    fn request(&self, _: ProviderObservation) {}
    fn response(&self, _: &str, _: &str) {}
    fn failure(&self, _: &ProviderRequestError) {}
}
pub(super) struct Clock;
impl ProviderClock for Clock {
    fn now_epoch_millis(&self) -> i64 {
        0
    }
}
pub(super) struct Metrics;
impl PromptUsageMetricSink for Metrics {
    fn append_request_diagnostic(
        &self,
        _: &serde_json::Value,
        _: Option<&str>,
    ) -> Result<(), butler_turn::btcc::ModelRoundError> {
        Ok(())
    }
    fn append(&self, input: PromptUsageMetricInput<'_>) -> Result<(), ModelRoundError> {
        println!(
            "{}",
            json!({"label":input.usage_attribution.and_then(|a|a.turn_id),
            "estimatedInputTokens":input.prompt_tokens,"prefixDiagnostics":input.prefix_diagnostics})
        );
        Ok(())
    }
}

pub(super) async fn server()
-> Result<(Url, tokio::task::JoinHandle<()>), Box<dyn std::error::Error>> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let endpoint = Url::parse(&format!("http://{}/responses", listener.local_addr()?))?;
    let tokenizer = tiktoken_rs::o200k_base()?;
    let task = tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            let Ok(body) = read_body(&mut stream).await else {
                break;
            };
            let mut prefix = String::new();
            for key in [
                "model",
                "tools",
                "tool_choice",
                "reasoning",
                "instructions",
                "input",
            ] {
                prefix.push_str(
                    &body
                        .get(key)
                        .unwrap_or(&serde_json::Value::Null)
                        .to_string(),
                );
                prefix.push('\n');
            }
            let tokens = tokenizer.encode_ordinary(&prefix).len();
            let event = json!({"type":"response.completed","response":{"id":"offline-response","status":"completed",
                "output":[],"output_text":"offline replay", "usage":{"input_tokens":tokens,"output_tokens":0,"total_tokens":tokens}}});
            let body = format!("data: {event}\n\n");
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            if stream.write_all(response.as_bytes()).await.is_err() {
                break;
            }
        }
    });
    Ok((endpoint, task))
}

async fn read_body(
    stream: &mut tokio::net::TcpStream,
) -> Result<serde_json::Value, Box<dyn std::error::Error + Send + Sync>> {
    let mut bytes = Vec::new();
    let mut chunk = [0; 8192];
    loop {
        let count = stream.read(&mut chunk).await?;
        if count == 0 {
            return Err("incomplete replay request".into());
        }
        bytes.extend_from_slice(&chunk[..count]);
        if bytes.len() > 16 * 1024 * 1024 {
            return Err("replay request too large".into());
        }
        if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
            let length: usize = std::str::from_utf8(&bytes[..end])?
                .lines()
                .find_map(|line| {
                    line.to_ascii_lowercase()
                        .strip_prefix("content-length:")
                        .map(str::trim)
                        .map(str::to_owned)
                })
                .ok_or("missing replay body length")?
                .parse()?;
            if bytes.len() >= end + 4 + length {
                return Ok(serde_json::from_slice(&bytes[end + 4..end + 4 + length])?);
            }
        }
    }
}
