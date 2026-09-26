//! One physical provider -> native file -> durable journal -> provider Turn.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;
use url::Url;

use super::*;
use crate::btcc::{
    AgentLoop, AgentLoopProgress, BtccStorage, ContextDocumentInput, DurableWorkService,
    GuidedContinuationBudgetFactory, ModelRoundError, ModelRouteEventWrite, ModelRouteRetryConfig,
    ModelRouteWrite, PortFuture, ProductionAgentLoop, RuntimeTurnEventInput, SessionWorkRepository,
    StorageEffectJournal, TestStorageFixture, ToolJournalRepository, TurnModelExecutionFactory,
    TurnStore, test_prepared_turn,
};
use crate::host::{NativeAcceptedPlanProducer, NativeGuidedCatalog, SystemIdentity};
use crate::locale::LocaleCollation;
use crate::models::{
    ModelCatalog, ModelCatalogSnapshot, ModelCatalogSnapshotInput, NativeModelProvider,
    PromptUsageMetricInput, PromptUsageMetricSink, ProviderAuth, ProviderClock,
    ProviderConfigFuture, ProviderConfigRequest, ProviderObservation, ProviderObservationSink,
    ProviderPromptCachePolicy, ProviderRequestConfig, ProviderRequestConfigPort,
    ProviderRoundPolicy,
};
use crate::workspace::{
    NativeCommands, NativeSessionWorkspaceRecovery, NativeWorkspaceFiles, SessionBindingStore,
    SessionBindingStoreConfig, WorkspaceMutations, WorkspaceStorageProfile,
};

struct EmptyProfiles;
impl crate::btcc::WorkerProfileReader for EmptyProfiles {
    fn list(&self) -> PortFuture<'_, Vec<crate::btcc::WorkerProfile>> {
        Box::pin(async { Ok(vec![]) })
    }
    fn read(&self, _: Option<String>) -> PortFuture<'_, crate::btcc::WorkerProfile> {
        Box::pin(async {
            Err(crate::btcc::BtccError::new(
                "worker_profile_missing",
                "missing",
            ))
        })
    }
}

struct Config {
    snapshot: Arc<ModelCatalogSnapshot>,
    endpoint: Url,
}
impl ProviderRequestConfigPort for Config {
    fn effective_prompt_model(&self, requested: Option<&str>) -> Result<String, ModelRoundError> {
        Ok(requested.unwrap_or("openai/gpt-5.5").into())
    }
    fn resolve<'a>(&'a self, _: ProviderConfigRequest<'a>) -> ProviderConfigFuture<'a> {
        Box::pin(async move {
            let metadata = self
                .snapshot
                .find_model_metadata(Some("openai/gpt-5.5"))
                .unwrap();
            Ok(ProviderRequestConfig {
                wire_model: metadata.model_id.clone(),
                api_shape: metadata.hosted_api_shape,
                metadata,
                endpoint: self.endpoint.clone(),
                auth: ProviderAuth::ApiKey("loopback-only".into()),
                policy: ProviderRoundPolicy {
                    total: Duration::from_secs(3),
                    idle: Some(Duration::from_secs(2)),
                    retry_base_ms: 0.0,
                },
                retry_attempts: 1.0,
                prompt_cache: ProviderPromptCachePolicy::default(),
                prompt_reasoning_effort: None,
            })
        })
    }
    fn sizing_snapshot(
        &self,
        _: Option<&str>,
    ) -> Result<Arc<ModelCatalogSnapshot>, ModelRoundError> {
        Ok(self.snapshot.clone())
    }
}
struct Clock;
impl ProviderClock for Clock {
    fn now_epoch_millis(&self) -> i64 {
        1_000
    }
}
struct Observations;
impl ProviderObservationSink for Observations {
    fn request(&self, _: ProviderObservation) {}
    fn response(&self, _: &str, _: &str) {}
    fn failure(&self, _: &crate::btcc::ProviderRequestError) {}
}
struct Metrics;
impl PromptUsageMetricSink for Metrics {
    fn append(&self, _: PromptUsageMetricInput<'_>) -> Result<(), ModelRoundError> {
        Ok(())
    }
}
#[derive(Default)]
struct Progress(Mutex<Vec<RuntimeTurnEventInput>>);
impl AgentLoopProgress for Progress {
    fn emit(&self, event: RuntimeTurnEventInput) -> PortFuture<'_, ()> {
        self.0.lock().unwrap().push(event);
        Box::pin(async { Ok(()) })
    }
}

async fn loopback(web_page_url: &str) -> (Url, tokio::task::JoinHandle<Vec<Value>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = Url::parse(&format!(
        "http://{}/v1/responses",
        listener.local_addr().unwrap()
    ))
    .unwrap();
    let web_page_url = web_page_url.to_owned();
    let served = tokio::spawn(async move {
        let mut bodies = Vec::new();
        for response in [
            json!({"id":"resp_1","model":"gpt-5.5","output":[
                {"type":"function_call","call_id":"file-call","name":"read_file",
                    "arguments":"{\"requests\":[{\"path\":\"proof.txt\"}]}"},
                {"type":"function_call","call_id":"search-call","name":"web_search",
                    "arguments":"{\"query\":\"example report\"}"},
                {"type":"function_call","call_id":"read-call","name":"web_read",
                    "arguments":serde_json::to_string(&json!({"url":web_page_url})).unwrap()}
            ]}),
            json!({"id":"resp_2","model":"gpt-5.5","output":[{"type":"message",
                "content":[{"type":"output_text","text":"The file and public page evidence were read."}]}]}),
        ] {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut chunk = [0u8; 4096];
            let body = loop {
                let read = socket.read(&mut chunk).await.unwrap();
                assert!(read > 0);
                request.extend_from_slice(&chunk[..read]);
                if let Some(split) = request.windows(4).position(|part| part == b"\r\n\r\n") {
                    let length = String::from_utf8_lossy(&request[..split])
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .and_then(|value| value.trim().parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    if request.len() >= split + 4 + length {
                        break request[split + 4..split + 4 + length].to_vec();
                    }
                }
            };
            bodies.push(serde_json::from_slice(&body).unwrap());
            let bytes = serde_json::to_vec(&response).unwrap();
            let headers = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                bytes.len()
            );
            socket.write_all(headers.as_bytes()).await.unwrap();
            socket.write_all(&bytes).await.unwrap();
        }
        bodies
    });
    (url, served)
}

async fn web_search_loopback() -> (String, String, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let page_url = format!("http://{address}/report");
    let search_page_url = page_url.clone();
    let served = tokio::spawn(async move {
        for _ in 0..2 {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0; 2_048];
            let read = socket.read(&mut request).await.unwrap();
            let request_line = String::from_utf8_lossy(&request[..read]);
            let body = if request_line.starts_with("GET /search?") {
                format!(
                    "<div class=\"result\"><a class=\"result__a\" href=\"{search_page_url}\">Example report</a><div class=\"result__snippet\">A public source snippet.</div></div>"
                )
            } else {
                "<html><head><title>Public report</title></head><body><main><p>web-read-turn-proof.</p></main></body></html>".into()
            };
            let headers = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            socket.write_all(headers.as_bytes()).await.unwrap();
            socket.write_all(body.as_bytes()).await.unwrap();
        }
    });
    (format!("http://{address}/search"), page_url, served)
}

struct Scratch(PathBuf);
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

mod native_factory;
