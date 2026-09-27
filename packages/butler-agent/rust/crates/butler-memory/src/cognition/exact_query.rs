//! Source-exact public Conversation scalar query, independent of graph generations.

mod args;
mod run;

use parking_lot::Mutex;
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use serde_json::Value;
use tokio::sync::{Semaphore, oneshot};
use tokio_util::task::TaskTracker;

use butler_turn::conversation::{CanonicalMemoryReadBinding, conversation_store_path};

use super::{CognitionError, CognitionResult};
use crate::cognition::CognitionCode;

pub struct ExactMemoryQuery {
    path: PathBuf,
    permits: Arc<Semaphore>,
    jobs: TaskTracker,
    closing: Mutex<bool>,
}

impl ExactMemoryQuery {
    pub fn new(data_root: &Path, read_concurrency: usize) -> Self {
        Self {
            path: conversation_store_path(data_root),
            permits: Arc::new(Semaphore::new(read_concurrency.max(1))),
            jobs: TaskTracker::new(),
            closing: Mutex::new(false),
        }
    }

    pub async fn query(
        &self,
        binding: CanonicalMemoryReadBinding,
        args: Value,
    ) -> CognitionResult<Value> {
        let permit = self
            .permits
            .clone()
            .acquire_owned()
            .await
            .map_err(|source| {
                CognitionError::new(CognitionCode::Closed, "Exact memory query is closing")
                    .with_source(source)
            })?;
        let path = self.path.clone();
        let (sender, receiver) = oneshot::channel();
        {
            let closing = self.closing.lock();
            if *closing {
                return Err(CognitionError::new(
                    CognitionCode::Closed,
                    "Exact memory query is closing",
                ));
            }
            self.jobs.spawn(async move {
                let result = tokio::task::spawn_blocking(move || {
                    let _permit = permit;
                    run::query(&path, &binding, &crate::lenient::view(&args))
                })
                .await
                .unwrap_or_else(|error| {
                    Err(CognitionError::new(
                        CognitionCode::QueryJoinFailed,
                        error.to_string(),
                    ))
                });
                let _ = sender.send(result);
            });
        }
        receiver.await.map_err(|source| {
            CognitionError::new(
                CognitionCode::QueryCompletionLost,
                "Exact query ended without result",
            )
            .with_source(source)
        })?
    }

    pub async fn close(&self) -> CognitionResult<()> {
        {
            let mut closing = self.closing.lock();
            *closing = true;
            self.permits.close();
            self.jobs.close();
        }
        self.jobs.wait().await;
        Ok(())
    }
}
