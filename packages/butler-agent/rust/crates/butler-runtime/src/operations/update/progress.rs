//! Updater-owned snapshot and change-driven notifications; no timers or idle writes.
use super::{UpdateCode, UpdateError};
use serde_json::{Value, json};
use std::{future::Future, pin::Pin, sync::Arc};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

type ReportFuture = Pin<Box<dyn Future<Output = Result<(), String>> + Send>>;
pub type UpdateProgressSink = Arc<dyn Fn(Value) -> ReportFuture + Send + Sync>;

#[derive(Clone)]
pub struct UpdateProgress {
    inner: Arc<Mutex<State>>,
}
#[derive(Default)]
struct State {
    snapshot: Value,
    revision: u64,
    download_started: Option<std::time::Instant>,
    sink: Option<UpdateProgressSink>,
    cancel: Option<CancellationToken>,
}
impl Default for UpdateProgress {
    fn default() -> Self {
        let revision = u64::try_from(chrono::Utc::now().timestamp_micros()).unwrap_or_default();
        Self {
            inner: Arc::new(Mutex::new(State {
                revision,
                snapshot: json!({"component":"app", "stage":"idle", "revision":revision,
                "bytes_done":null, "bytes_total":null, "cancellable":false, "error_code":null}),
                ..State::default()
            })),
        }
    }
}
impl UpdateProgress {
    pub async fn set_sink(&self, sink: UpdateProgressSink) {
        self.inner.lock().await.sink = Some(sink);
    }
    pub async fn snapshot(&self) -> Value {
        self.inner.lock().await.snapshot.clone()
    }
    pub async fn begin(&self, token: CancellationToken) -> Result<(), UpdateError> {
        {
            let mut state = self.inner.lock().await;
            state.cancel = Some(token);
            state.download_started = None;
        }
        self.report("checking", None, None, None).await
    }
    pub async fn cancel(&self) -> bool {
        let state = self.inner.lock().await;
        if state.snapshot["stage"] != "downloading" {
            return false;
        }
        if let Some(token) = &state.cancel {
            token.cancel();
            return true;
        }
        false
    }
    pub async fn host_stage(&self, stage: &str) -> Result<Value, UpdateError> {
        let prior = self.snapshot().await;
        let allowed = match stage {
            "verifying" | "applying" => prior["stage"] == "ready",
            "ready" => prior["stage"] == "verifying" || prior["stage"] == "applying",
            "restarting" => prior["stage"] == "applying",
            "failed" => matches!(
                prior["stage"].as_str(),
                Some("ready" | "verifying" | "applying" | "restarting")
            ),
            _ => false,
        };
        if !allowed {
            return Err(UpdateCode::UpdateStatusInvalid.into());
        }
        self.report(
            stage,
            None,
            None,
            (stage == "failed").then_some("update_activation_failed"),
        )
        .await?;
        Ok(self.snapshot().await)
    }
    pub async fn report(
        &self,
        stage: &str,
        done: Option<u64>,
        total: Option<u64>,
        error: Option<&str>,
    ) -> Result<(), UpdateError> {
        let mut state = self.inner.lock().await;
        state.revision += 1;
        let speed = if stage == "downloading" {
            let elapsed = state
                .download_started
                .get_or_insert_with(std::time::Instant::now)
                .elapsed()
                .as_millis();
            let millis = u64::try_from(elapsed).unwrap_or(u64::MAX);
            (millis >= 200).then(|| done.unwrap_or_default().saturating_mul(1_000) / millis)
        } else {
            None
        };
        let value = json!({"component":"app", "stage":stage, "revision":state.revision,
            "bytes_done":done, "bytes_total":total, "bytes_per_second":speed,
            "cancellable":stage == "downloading" && state.cancel.is_some(), "error_code":error});
        // Serialize delivery with the snapshot: concurrent clients cannot observe reversed revisions.
        if let Some(sink) = &state.sink {
            sink(value.clone())
                .await
                .map_err(|_| UpdateCode::UpdateStageUnavailable)?;
        }
        state.snapshot = value;
        if !matches!(stage, "checking" | "downloading" | "verifying") {
            state.cancel = None;
        }
        Ok(())
    }
}
