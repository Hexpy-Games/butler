//! Caller-drop-safe accepted recall work and source-owning close/drain.
//!
//! [`MemoryRecall::recall_tool`] binds the caller and parses the tool
//! arguments, then [`MemoryRecall::recall`] runs one detached operation:
//! admission, the pinned generation (and continuation checks), an optional
//! bounded vector search, and the blocking graph query.

use parking_lot::Mutex;
use std::{cmp::Ordering, path::PathBuf, sync::Arc};

use tokio::sync::{Semaphore, oneshot};
use tokio_util::{sync::CancellationToken, task::TaskTracker};

use crate::cognition::{
    CognitionError, CognitionPathEnvironment, CognitionResult, MemoryGenerationHandle,
    recall::{RecallRequest, RecallResponse},
    resolve_active_generation,
};

use super::{
    Clocks, continuation,
    cursor::{self, CursorStore, Page},
    query::{self, PageRead},
    response::VectorFacts,
    tool::{PreparedRecall, RecallCaller, RecallToolArgs},
    validate,
};
use crate::cognition::CognitionCode;

pub(crate) type DateParsePort = Arc<dyn Fn(&str) -> Option<i64> + Send + Sync>;
pub(crate) type LocaleComparePort = Arc<dyn Fn(&str, &str) -> Ordering + Send + Sync>;
pub(crate) type RecallClock = Arc<dyn Fn() -> i64 + Send + Sync>;

/// Owner of recall operations over the active memory generation. Operations
/// are admitted up to the read concurrency and drained by [`Self::close`].
pub struct MemoryRecall {
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
    details: Arc<super::details::DetailStore>,
    vector_port: Option<Arc<dyn super::vector::RecallVectorPort>>,
    metrics: Option<Arc<dyn super::metrics::RecallMetricSink>>,
}

/// Everything one detached recall operation owns.
struct Operation {
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
    vector_port: Option<Arc<dyn super::vector::RecallVectorPort>>,
    metrics: Option<Arc<dyn super::metrics::RecallMetricSink>>,
}

impl MemoryRecall {
    /// The `recall_memory` tool: binds the caller's conversation, checks the
    /// arguments and recalls. Parse boundary: `args` is the tool call's JSON
    /// arguments; the result is the tool's JSON result.
    pub async fn recall_tool(
        &self,
        binding: butler_turn::conversation::CanonicalMemoryReadBinding,
        current_user_message: String,
        operation_id: String,
        args: serde_json::Value,
    ) -> CognitionResult<serde_json::Value> {
        if args.get("detail_handles").is_some() {
            return self.expand_details(binding, args).await;
        }
        let detail_binding = binding.clone();
        let args: RecallToolArgs = crate::lenient::view(&args);
        let permit = self
            .admission
            .clone()
            .acquire_owned()
            .await
            .map_err(|source| closed().with_source(source))?;
        let token = self.operation_token()?;
        let root = self.data_root.clone();
        let environment = self.environment.clone();
        let now = butler_core::js_date::format_iso_millis((self.clock)()).ok_or_else(|| {
            CognitionError::new(CognitionCode::InvalidClock, "Invalid recall clock")
        })?;
        let caller = RecallCaller {
            binding,
            current_user_message,
            operation_id,
        };
        let prepared = tokio::task::spawn_blocking(move || {
            let _token = token;
            let _permit = permit;
            super::tool::prepare(&root, &environment, caller, &args, &now)
        })
        .await
        .map_err(|source| {
            CognitionError::new(
                CognitionCode::RecallBindingFailed,
                "Recall binding read failed",
            )
            .with_source(source)
        })??;
        let request = match prepared {
            PreparedRecall::BindingFailure(failure) => return encode(&failure),
            PreparedRecall::Request(request) => *request,
        };
        let response = self.recall(request).await?;
        let mut value = encode(&response)?;
        self.details.compact(
            &mut value,
            response.detail_pin.as_ref(),
            &response.full_details,
            &detail_binding,
            (self.clock)(),
        )?;
        if let Some(object) = value.as_object_mut() {
            object.insert("ok".into(), true.into());
        }
        Ok(value)
    }

    async fn expand_details(
        &self,
        binding: butler_turn::conversation::CanonicalMemoryReadBinding,
        args: serde_json::Value,
    ) -> CognitionResult<serde_json::Value> {
        let permit = self
            .admission
            .clone()
            .acquire_owned()
            .await
            .map_err(|source| closed().with_source(source))?;
        let token = self.operation_token()?;
        let root = self.data_root.clone();
        let environment = self.environment.clone();
        let details = self.details.clone();
        let now = (self.clock)();
        tokio::task::spawn_blocking(move || {
            let _token = token;
            let _permit = permit;
            super::details::expand(&root, &environment, &details, &binding, &args, now)
        })
        .await
        .map_err(|source| {
            CognitionError::new(
                CognitionCode::RecallBindingFailed,
                "Recall detail read failed",
            )
            .with_source(source)
        })?
    }

    /// A recall owner over `data_root` admitting `read_concurrency`
    /// operations at a time.
    pub fn new(
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
            details: Arc::new(super::details::DetailStore::default()),
            vector_port: None,
            metrics: None,
        }
    }

    /// Adds the generation-bound vector search.
    pub fn with_vector_port(mut self, port: Arc<dyn super::vector::RecallVectorPort>) -> Self {
        self.vector_port = Some(port);
        self
    }

    /// Adds the sink recall metrics are reported to.
    pub fn with_metric_sink(mut self, sink: Arc<dyn super::metrics::RecallMetricSink>) -> Self {
        self.metrics = Some(sink);
        self
    }

    pub(crate) async fn recall(&self, request: RecallRequest) -> CognitionResult<RecallResponse> {
        let input = validate::normalize(request, |value| (self.parse_date)(value))?;
        let token = self.operation_token()?;
        let operation = Operation {
            data_root: self.data_root.clone(),
            environment: self.environment.clone(),
            input,
            deadline_at: (self.clock)() + 5_000,
            parse_date: self.parse_date.clone(),
            compare_locale: self.compare_locale.clone(),
            clock: self.clock.clone(),
            admission: self.admission.clone(),
            shutdown: self.shutdown.clone(),
            cursors: self.cursors.clone(),
            vector_port: self.vector_port.clone(),
            metrics: self.metrics.clone(),
        };
        let (sender, receiver) = oneshot::channel();
        // Detached on purpose: the operation token/guard moved into the task keeps the
        // owner's close waiting for it, and the result returns through the oneshot,
        // so a cancelled caller cannot abandon the operation midway.
        tokio::spawn(async move {
            let _token = token;
            let _ = sender.send(operation.run().await);
        });
        receiver.await.map_err(|source| {
            CognitionError::new(
                CognitionCode::MemoryRecallOperationFailed,
                "memory_recall_operation_failed",
            )
            .with_source(source)
        })?
    }

    /// Stops admitting operations and waits for running ones to finish.
    pub async fn close(&self) {
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

    /// A tracker token for a new operation, unless the owner is closing.
    fn operation_token(&self) -> CognitionResult<tokio_util::task::task_tracker::TaskTrackerToken> {
        let closing = self.lifecycle.lock();
        if *closing {
            return Err(closed());
        }
        Ok(self.operations.token())
    }
}

impl Operation {
    async fn run(self) -> CognitionResult<RecallResponse> {
        let _permit = tokio::select! {
            result=self.admission.clone().acquire_owned()=>result.map_err(|source| closed().with_source(source))?,
            ()=self.shutdown.cancelled()=>return Err(closed()),
        };
        if self.shutdown.is_cancelled() {
            return Err(closed());
        }
        let page = self
            .input
            .cursor
            .as_deref()
            .map(|cursor| self.cursors.read(cursor, (self.clock)()))
            .transpose()?;
        // Generation is pinned before any future vector suspension. No SQLite
        // transaction or canonical reader exists until the blocking query begins.
        let generation = resolve_active_generation(&self.data_root, &self.environment)?;
        if let Some(page) = &page {
            self.check_continuation(page, &generation)?;
        }
        let vector = if page.is_none() && self.input.include_vector {
            self.vector_facts(&generation).await?
        } else {
            VectorFacts::default()
        };
        tokio::task::spawn_blocking(move || self.query(page.as_ref(), &generation, &vector))
            .await
            .map_err(|error| {
                CognitionError::new(
                    CognitionCode::MemoryRecallOperationFailed,
                    error.to_string(),
                )
                .with_source(error)
            })?
    }

    /// A cursor continues only on its own generation, `as_of` and arguments.
    fn check_continuation(
        &self,
        page: &Page,
        generation: &MemoryGenerationHandle,
    ) -> CognitionResult<()> {
        let input = &self.input;
        if generation.generation_id != page.inventory.generation_id
            || input.as_of_explicit && input.as_of != page.inventory.as_of
            || cursor::argument_hash(input, &page.inventory.as_of)? != page.inventory.argument_hash
        {
            return Err(continuation::stale());
        }
        Ok(())
    }

    /// The vector lane: searched within 750 ms (or the deadline), or the code
    /// of why it was not.
    async fn vector_facts(
        &self,
        generation: &MemoryGenerationHandle,
    ) -> CognitionResult<VectorFacts> {
        let mut vector = VectorFacts::default();
        let Some(port) = &self.vector_port else {
            vector.code = Some(if generation.embedding.is_none() {
                "embedding_not_configured".into()
            } else {
                "vector_unavailable".into()
            });
            return Ok(vector);
        };
        if generation.embedding.is_none() {
            vector.code = Some("embedding_not_configured".into());
            return Ok(vector);
        }
        let clock = &self.clock;
        let vector_deadline = self.deadline_at.min(clock() + 750);
        let remaining = u64::try_from(vector_deadline.saturating_sub(clock())).unwrap_or_default();
        let result = tokio::select! {
            ()=self.shutdown.cancelled()=>return Err(closed()),
            result=tokio::time::timeout(std::time::Duration::from_millis(remaining),
                port.search(generation, &self.input, vector_deadline))=>result,
        };
        match result {
            Ok(Ok(matches)) => {
                vector.searched = true;
                vector.diagnostics = matches.diagnostics.clone();
                vector.matches = Some(matches);
            }
            Ok(Err(error)) => vector.code = Some(vector_error_code(&error)),
            Err(_) => vector.code = Some("vector_unavailable".into()),
        }
        Ok(vector)
    }

    /// The first page, or the next page of a cursor (at the cursor's `as_of`).
    fn query(
        &self,
        page: Option<&Page>,
        generation: &MemoryGenerationHandle,
        vector: &VectorFacts,
    ) -> CognitionResult<RecallResponse> {
        let parse = |value: &str| (self.parse_date)(value).map_or(f64::NAN, |millis| millis as f64);
        let now = || (self.clock)();
        let compare = |a: &str, b: &str| (self.compare_locale)(a, b);
        let clocks = Clocks {
            now_millis: &now,
            parse_date: &parse,
            compare_locale: &compare,
        };
        let mut read = PageRead {
            data_root: &self.data_root,
            environment: &self.environment,
            generation,
            input: &self.input,
            cursors: &self.cursors,
            deadline_at: self.deadline_at,
        };
        if let Some(page) = page {
            let mut effective = self.input.clone();
            effective.as_of = page.inventory.as_of.clone();
            read.input = &effective;
            query::continue_page(&read, page, clocks)
        } else {
            query::initial(&read, vector, self.metrics.as_deref(), clocks)
        }
    }
}

/// A vector port error's message when it is a snake_case code.
fn vector_error_code(error: &CognitionError) -> String {
    let message = error.message();
    if !message.is_empty()
        && message
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_')
    {
        message
    } else {
        "vector_unavailable".into()
    }
}

fn encode(value: &impl serde::Serialize) -> CognitionResult<serde_json::Value> {
    serde_json::to_value(value).map_err(|source| {
        CognitionError::new(
            CognitionCode::RecallResultEncodingFailed,
            "Recall result encoding failed",
        )
        .with_source(source)
    })
}

fn closed() -> CognitionError {
    CognitionError::new(CognitionCode::MemoryRecallClosed, "memory_recall_closed")
}
