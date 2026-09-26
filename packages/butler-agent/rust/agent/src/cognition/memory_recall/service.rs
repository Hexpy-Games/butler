//! Caller-drop-safe accepted recall work and source-owning close/drain.

use parking_lot::Mutex;
use std::{cmp::Ordering, path::PathBuf, sync::Arc};

use tokio::sync::{Semaphore, oneshot};
use tokio_util::{sync::CancellationToken, task::TaskTracker};

use crate::cognition::{
    CognitionError, CognitionPathEnvironment, CognitionResult,
    recall::{RecallRequest, RecallResponse},
    resolve_active_generation,
};

use super::{
    continuation,
    cursor::{self, CursorStore},
    query,
    response::VectorFacts,
    validate,
};

pub(crate) type DateParsePort = Arc<dyn Fn(&str) -> Option<i64> + Send + Sync>;
pub(crate) type LocaleComparePort = Arc<dyn Fn(&str, &str) -> Ordering + Send + Sync>;
pub(crate) type RecallClock = Arc<dyn Fn() -> i64 + Send + Sync>;

pub(crate) struct NativeMemoryRecall {
    data_root: PathBuf,
    environment: CognitionPathEnvironment,
    parse_date: DateParsePort,
    compare_locale: LocaleComparePort,
    clock: RecallClock,
    admission: Arc<Semaphore>,
    shutdown: CancellationToken,
    operations: TaskTracker,
    lifecycle: Mutex<bool>,
    cursors: Arc<CursorStore>,
    vector_port: Option<Arc<dyn super::vector::NativeRecallVectorPort>>,
    metrics: Option<Arc<dyn super::metrics::RecallMetricSink>>,
}

impl NativeMemoryRecall {
    pub(crate) async fn recall_tool(
        &self,
        binding: crate::conversation::CanonicalMemoryReadBinding,
        current_user_message: String,
        operation_id: String,
        args: serde_json::Value,
    ) -> CognitionResult<serde_json::Value> {
        let permit = self
            .admission
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| closed())?;
        let token = {
            let closing = self.lifecycle.lock();
            if *closing {
                return Err(closed());
            }
            self.operations.token()
        };
        let root = self.data_root.clone();
        let environment = self.environment.clone();
        let now = crate::js_date::format_iso_millis((self.clock)())
            .ok_or_else(|| CognitionError::new("invalid_clock", "Invalid recall clock"))?;
        let prepared = tokio::task::spawn_blocking(move || {
            let _token = token;
            let _permit = permit;
            super::tool::prepare(
                &root,
                &environment,
                binding,
                current_user_message,
                operation_id,
                args,
                now,
            )
        })
        .await
        .map_err(|_| {
            CognitionError::new("recall_binding_failed", "Recall binding read failed")
        })??;
        let request = match prepared {
            super::tool::PreparedRecall::BindingFailure(value) => return Ok(value),
            super::tool::PreparedRecall::Request(request) => *request,
        };
        let result = self.recall(request).await?;
        let mut value = serde_json::to_value(result).map_err(|_| {
            CognitionError::new(
                "recall_result_encoding_failed",
                "Recall result encoding failed",
            )
        })?;
        value
            .as_object_mut()
            .expect("recall response object")
            .insert("ok".into(), true.into());
        Ok(value)
    }

    pub(crate) fn new(
        data_root: PathBuf,
        environment: CognitionPathEnvironment,
        parse_date: DateParsePort,
        compare_locale: LocaleComparePort,
        clock: RecallClock,
        read_concurrency: usize,
    ) -> Self {
        Self {
            data_root,
            environment,
            parse_date,
            compare_locale,
            clock,
            admission: Arc::new(Semaphore::new(read_concurrency)),
            shutdown: CancellationToken::new(),
            operations: TaskTracker::new(),
            lifecycle: Mutex::new(false),
            cursors: Arc::new(CursorStore::default()),
            vector_port: None,
            metrics: None,
        }
    }

    pub(crate) fn with_vector_port(
        mut self,
        port: Arc<dyn super::vector::NativeRecallVectorPort>,
    ) -> Self {
        self.vector_port = Some(port);
        self
    }

    pub(crate) fn with_metric_sink(
        mut self,
        sink: Arc<dyn super::metrics::RecallMetricSink>,
    ) -> Self {
        self.metrics = Some(sink);
        self
    }

    pub(crate) async fn recall(&self, request: RecallRequest) -> CognitionResult<RecallResponse> {
        let input = validate::normalize(request, |value| (self.parse_date)(value))?;
        let deadline_at = (self.clock)() + 5_000;
        let token = {
            let closing = self.lifecycle.lock();
            if *closing {
                return Err(closed());
            }
            self.operations.token()
        };
        let data_root = self.data_root.clone();
        let environment = self.environment.clone();
        let parse_date = self.parse_date.clone();
        let compare_locale = self.compare_locale.clone();
        let clock = self.clock.clone();
        let admission = self.admission.clone();
        let shutdown = self.shutdown.clone();
        let cursors = self.cursors.clone();
        let vector_port = self.vector_port.clone();
        let metrics = self.metrics.clone();
        let (sender, receiver) = oneshot::channel();
        tokio::spawn(async move {
            let _token = token;
            let result = operation(
                data_root,
                environment,
                input,
                deadline_at,
                parse_date,
                compare_locale,
                clock,
                admission,
                shutdown,
                cursors,
                vector_port,
                metrics,
            )
            .await;
            let _ = sender.send(result);
        });
        receiver.await.map_err(|_| {
            CognitionError::new(
                "memory_recall_operation_failed",
                "memory_recall_operation_failed",
            )
        })?
    }

    pub(crate) async fn close(&self) {
        {
            let mut closing = self.lifecycle.lock();
            if !*closing {
                *closing = true;
                self.shutdown.cancel();
                self.operations.close();
                self.admission.close();
            }
        }
        self.operations.wait().await;
    }
}

#[allow(clippy::too_many_arguments)]
async fn operation(
    data_root: PathBuf,
    environment: CognitionPathEnvironment,
    input: RecallRequest,
    deadline_at: i64,
    parse_date: DateParsePort,
    compare_locale: LocaleComparePort,
    clock: RecallClock,
    admission: Arc<Semaphore>,
    shutdown: CancellationToken,
    cursors: Arc<CursorStore>,
    vector_port: Option<Arc<dyn super::vector::NativeRecallVectorPort>>,
    metrics: Option<Arc<dyn super::metrics::RecallMetricSink>>,
) -> CognitionResult<RecallResponse> {
    let _permit = tokio::select! {
        result=admission.acquire_owned()=>result.map_err(|_|closed())?,
        _=shutdown.cancelled()=>return Err(closed()),
    };
    if shutdown.is_cancelled() {
        return Err(closed());
    }
    let page = input
        .cursor
        .as_deref()
        .map(|cursor| cursors.read(cursor, clock()))
        .transpose()?;
    // Generation is pinned before any future vector suspension. No SQLite
    // transaction or canonical reader exists until the blocking query begins.
    let generation = resolve_active_generation(&data_root, &environment)?;
    if let Some(page) = &page {
        if generation.generation_id != page.inventory.generation_id {
            return Err(continuation::stale());
        }
        if input.as_of_explicit && input.as_of != page.inventory.as_of {
            return Err(continuation::stale());
        }
        let hash = cursor::argument_hash(&input, &page.inventory.as_of)?;
        if hash != page.inventory.argument_hash {
            return Err(continuation::stale());
        }
    }
    let mut vector = VectorFacts {
        code: None,
        diagnostics: vec![],
        candidates: 0,
        partial: false,
        searched: false,
        matches: None,
    };
    if page.is_none() && input.include_vector {
        if generation.embedding.is_none() {
            vector.code = Some("embedding_not_configured".into());
        } else if let Some(port) = vector_port {
            let vector_deadline = deadline_at.min(clock() + 750);
            let remaining = vector_deadline.saturating_sub(clock()) as u64;
            let result = tokio::select! {
                _=shutdown.cancelled()=>return Err(closed()),
                result=tokio::time::timeout(std::time::Duration::from_millis(remaining),
                    port.search(&generation, &input, vector_deadline))=>result,
            };
            match result {
                Ok(Ok(matches)) => {
                    vector.searched = true;
                    vector.diagnostics = matches.diagnostics.clone();
                    vector.matches = Some(matches);
                }
                Ok(Err(error)) => {
                    vector.code =
                        Some(
                            if error.message.chars().all(|ch| {
                                ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_'
                            }) && !error.message.is_empty()
                            {
                                error.message
                            } else {
                                "vector_unavailable".into()
                            },
                        );
                }
                Err(_) => vector.code = Some("vector_unavailable".into()),
            }
        } else {
            vector.code = Some("vector_unavailable".into());
        }
    }
    tokio::task::spawn_blocking(move || {
        let parse = |value: &str| parse_date(value).map_or(f64::NAN, |millis| millis as f64);
        if let Some(page) = page {
            let mut effective = input.clone();
            effective.as_of = page.inventory.as_of.clone();
            query::continue_page(
                &data_root,
                &environment,
                &generation,
                &effective,
                &page,
                &cursors,
                deadline_at,
                &|| clock(),
                &parse,
                &|a, b| compare_locale(a, b),
            )
        } else {
            query::initial(
                &data_root,
                &environment,
                &generation,
                &input,
                &vector,
                &cursors,
                metrics.as_deref(),
                deadline_at,
                &|| clock(),
                &parse,
                &|a, b| compare_locale(a, b),
            )
        }
    })
    .await
    .map_err(|error| CognitionError::new("memory_recall_operation_failed", error.to_string()))?
}

fn closed() -> CognitionError {
    CognitionError::new("memory_recall_closed", "memory_recall_closed")
}
