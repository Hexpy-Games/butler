//! Source-exact public Conversation scalar query, independent of graph generations.

mod args;
mod run;

use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};

use serde_json::Value;
use tokio::sync::{Semaphore, oneshot};
use tokio_util::task::TaskTracker;

use crate::conversation::{CanonicalMemoryReadBinding, conversation_store_path};

use super::{CognitionError, CognitionResult};

pub(crate) struct NativeExactMemoryQuery {
    path: PathBuf,
    permits: Arc<Semaphore>,
    jobs: TaskTracker,
    closing: Mutex<bool>,
}

impl NativeExactMemoryQuery {
    pub(crate) fn new(data_root: PathBuf, read_concurrency: usize) -> Self {
        Self {
            path: conversation_store_path(&data_root),
            permits: Arc::new(Semaphore::new(read_concurrency.max(1))),
            jobs: TaskTracker::new(),
            closing: Mutex::new(false),
        }
    }

    pub(crate) async fn query(
        &self,
        binding: CanonicalMemoryReadBinding,
        args: Value,
    ) -> CognitionResult<Value> {
        let permit = self
            .permits
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| CognitionError::new("closed", "Exact memory query is closing"))?;
        let path = self.path.clone();
        let (sender, receiver) = oneshot::channel();
        {
            let closing = self.closing.lock().expect("exact query owner poisoned");
            if *closing {
                return Err(CognitionError::new(
                    "closed",
                    "Exact memory query is closing",
                ));
            }
            self.jobs.spawn(async move {
                let result = tokio::task::spawn_blocking(move || {
                    let _permit = permit;
                    run::query(&path, &binding, &args)
                })
                .await
                .unwrap_or_else(|error| {
                    Err(CognitionError::new("query_join_failed", error.to_string()))
                });
                let _ = sender.send(result);
            });
        }
        receiver.await.map_err(|_| {
            CognitionError::new("query_completion_lost", "Exact query ended without result")
        })?
    }

    pub(crate) async fn close(&self) -> CognitionResult<()> {
        {
            let mut closing = self.closing.lock().expect("exact query owner poisoned");
            *closing = true;
            self.permits.close();
            self.jobs.close();
        }
        self.jobs.wait().await;
        Ok(())
    }
}
