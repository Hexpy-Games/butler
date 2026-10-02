//! Observe native query inference without changing adapter results or deadlines.
use butler_memory::cognition::{CognitionEmbeddingPort, EmbeddingFuture, EmbeddingRequest};
use parking_lot::Mutex;
use serde_json::{Value, json};
use std::{sync::Arc, time::Instant};
use tokio_util::sync::CancellationToken;

pub(crate) struct Trace {
    pub(crate) embedding: Arc<dyn CognitionEmbeddingPort>,
    pub(crate) last: Arc<Mutex<Value>>,
}

struct Attempt {
    last: Arc<Mutex<Value>>,
    start: Instant,
    finished: bool,
}

impl Drop for Attempt {
    fn drop(&mut self) {
        if !self.finished {
            // Calls are sequential and close runs after all calls: only the
            // product timeout can drop pending inference in this harness.
            *self.last.lock() =
                json!({"state":"timed_out", "wall_ms":self.start.elapsed().as_secs_f64()*1000.0});
        }
    }
}

impl CognitionEmbeddingPort for Trace {
    fn embed(
        &self,
        request: EmbeddingRequest,
        cancellation: CancellationToken,
    ) -> EmbeddingFuture<'_> {
        Box::pin(async move {
            let mut attempt = Attempt {
                last: self.last.clone(),
                start: Instant::now(),
                finished: false,
            };
            *self.last.lock() = json!({"state":"running"});
            let result = self.embedding.embed(request, cancellation).await;
            attempt.finished = true;
            *self.last.lock() = match &result {
                Ok(response) => {
                    json!({"state":"ran", "embedding_count":response.embeddings.len(), "wall_ms":attempt.start.elapsed().as_secs_f64()*1000.0})
                }
                Err(error) => {
                    json!({"state":if error.code()=="embed_request_deadline" {"timed_out"} else {"unavailable"}, "error":error.to_string(), "wall_ms":attempt.start.elapsed().as_secs_f64()*1000.0})
                }
            };
            result
        })
    }
}
