//! Each admitted HTTP attempt has a durable, content-free start record, even
//! when cancelled, retried or interrupted before usage arrives.
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};

use super::{
    ModelProvider,
    prefix_diagnostics::{History, Prepared},
};
use crate::models::PromptUsageMetricSink;
use butler_turn::btcc::ModelRoundError;
use parking_lot::Mutex;
use serde_json::Value;
use sha2::{Digest, Sha256};

static REQUEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub(crate) struct RequestTrace {
    prepared: Prepared,
    history: Arc<History>,
    sink: Arc<dyn PromptUsageMetricSink>,
    scope: Option<String>,
    data: Option<String>,
    phase: String,
    round: Option<f64>,
    kind: String,
    latest: Mutex<Option<Value>>,
}

impl RequestTrace {
    pub(super) async fn round(
        provider: &ModelProvider,
        prepared: Prepared,
        request: &butler_turn::btcc::ModelRoundRequest<'_>,
    ) -> Result<Self, ModelRoundError> {
        Self::new(
            provider,
            prepared,
            request.cache_scope,
            request.usage_attribution.map(|a| a.phase.as_str()),
            request
                .usage_attribution
                .and_then(|a| a.round_index)
                .map(f64::from),
            request
                .usage_attribution
                .and_then(|a| a.session_kind.as_deref())
                .unwrap_or("parent"),
            request.butler_data,
        )
        .await
    }

    pub(super) async fn new(
        provider: &ModelProvider,
        prepared: Prepared,
        scope: Option<&str>,
        phase: Option<&str>,
        round: Option<f64>,
        kind: &str,
        data: Option<&str>,
    ) -> Result<Self, ModelRoundError> {
        Ok(Self {
            prepared: prepared.tokenize(provider.catalog.clone()).await?,
            history: provider.prefix_history.clone(),
            sink: provider.prompt_metrics.clone(),
            scope: scope.map(str::to_owned),
            data: data.map(str::to_owned),
            phase: phase.unwrap_or("background").into(),
            round,
            kind: kind.into(),
            latest: Mutex::new(None),
        })
    }

    pub(crate) async fn start(&self) -> Result<(), ModelRoundError> {
        let prepared = self.prepared.clone();
        let history = self.history.clone();
        let sink = self.sink.clone();
        let scope = self.scope.clone();
        let data = self.data.clone();
        let phase = self.phase.clone();
        let kind = self.kind.clone();
        let sequence = REQUEST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let request_id = uuid::Uuid::new_v4().simple().to_string();
        let round = self.round.unwrap_or(sequence as f64);
        let metadata = tokio::task::spawn_blocking(move || {
            let mut metadata = history.observe(scope.as_deref(), prepared);
            metadata["requestId"] = request_id.clone().into();
            metadata["sessionSha256"] = format!(
                "{:x}",
                Sha256::digest(scope.as_deref().unwrap_or(&request_id))
            )
            .into();
            metadata["sessionKind"] = kind.into();
            metadata["phase"] = phase.into();
            metadata["round"] = serde_json::json!(round);
            metadata["requestStarted"] = true.into();
            sink.append_request_diagnostic(&metadata, data.as_deref())?;
            metadata["requestStarted"] = false.into();
            Ok::<_, ModelRoundError>(metadata)
        })
        .await
        .map_err(|error| ModelRoundError::InvocationFailure {
            code: Some("request_trace_failed".into()),
            message: error.to_string(),
        })??;
        *self.latest.lock() = Some(metadata);
        Ok(())
    }

    pub(crate) async fn finish_attempt(
        &self,
        response: Option<&Value>,
    ) -> Result<(), ModelRoundError> {
        self.finish(
            response,
            if response.is_some() {
                "completed"
            } else {
                "failed"
            },
        )
        .await
    }

    pub(crate) async fn finish(
        &self,
        response: Option<&Value>,
        status: &str,
    ) -> Result<(), ModelRoundError> {
        let Some(mut metadata) = self.latest() else {
            return Ok(());
        };
        metadata["requestStarted"] = false.into();
        metadata["status"] = status.into();
        if let Some(response) = response {
            super::prefix_diagnostics::reported_usage(&mut metadata, response);
        }
        let sink = self.sink.clone();
        let data = self.data.clone();
        let persisted = metadata.clone();
        tokio::task::spawn_blocking(move || {
            sink.append_request_diagnostic(&persisted, data.as_deref())
        })
        .await
        .map_err(|error| ModelRoundError::InvocationFailure {
            code: Some("request_trace_failed".into()),
            message: error.to_string(),
        })??;
        *self.latest.lock() = Some(metadata);
        Ok(())
    }

    pub(super) fn latest(&self) -> Option<Value> {
        self.latest.lock().clone()
    }
}
