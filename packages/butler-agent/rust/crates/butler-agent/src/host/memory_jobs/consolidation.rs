//! Process-owned consolidation admission, receipts and serialized durable results.
use super::{
    daily::DailyCognitionJobs,
    daily_schedule::{iso_at, read_state, write_state},
};
use crate::host::HostError;
use butler_gateway::gateway::MemoryEventSink;
use butler_memory::{cognition::CognitionPathEnvironment, coordination::CognitionWriteCoordinator};
use parking_lot::RwLock;
use serde_json::{Value, json};
use std::{collections::HashMap, path::PathBuf, sync::Arc};
use tokio::sync::{Mutex, watch};
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub(in crate::host) struct Schedule {
    pub(in crate::host) time: String,
    pub(in crate::host) changed_at: Option<i64>,
    pub(in crate::host) timezone: Arc<crate::host::DateParser>,
}

pub(in crate::host) struct ConsolidationRunGate {
    pub(in crate::host) admission: Mutex<()>,
    pub(in crate::host) jobs: Arc<std::sync::Mutex<HashMap<String, CancellationToken>>>,
    active: RwLock<Option<Value>>,
    idle: tokio::sync::Notify,
    sink: RwLock<Option<MemoryEventSink>>,
    schedule: watch::Sender<Schedule>,
    root: PathBuf,
    paths: CognitionPathEnvironment,
    coordinator: Arc<CognitionWriteCoordinator>,
}

impl ConsolidationRunGate {
    pub(in crate::host) async fn open(
        root: PathBuf,
        paths: CognitionPathEnvironment,
        coordinator: Arc<CognitionWriteCoordinator>,
        fallback_timezone: Arc<crate::host::DateParser>,
    ) -> Result<Arc<Self>, HostError> {
        let data = root.clone();
        let (time, changed_at, timezone) = tokio::task::spawn_blocking(move || {
            let config =
                butler_core::configuration::read_json_object(&data.join("butler.config.json"))
                    .map_err(HostError::from_error)?;
            let time = config
                .pointer("/cognition/consolidationCycle/timeOfDay")
                .and_then(Value::as_str)
                .unwrap_or("04:00")
                .to_owned();
            let state = read_state(&data, "consolidation-cycle")?;
            let changed_at = state
                .filter(|s| s["schedule"]["timeOfDay"] == time)
                .and_then(|s| s["schedule"]["changedAtMs"].as_i64());
            let timezone = match config.pointer("/user/timezone").and_then(Value::as_str) {
                Some(name) => {
                    Arc::new(crate::host::DateParser::new(name).map_err(HostError::from_error)?)
                }
                None => fallback_timezone,
            };
            Ok::<_, HostError>((time, changed_at, timezone))
        })
        .await
        .map_err(HostError::from_error)??;
        let (schedule, _) = watch::channel(Schedule {
            time,
            changed_at,
            timezone,
        });
        Ok(Arc::new(Self {
            admission: Mutex::new(()),
            jobs: Arc::default(),
            active: RwLock::new(None),
            idle: tokio::sync::Notify::new(),
            sink: RwLock::new(None),
            schedule,
            root,
            paths,
            coordinator,
        }))
    }

    pub(in crate::host) async fn wait_idle(&self) {
        loop {
            let idle = self.idle.notified();
            tokio::pin!(idle);
            idle.as_mut().enable();
            if self.active().is_none() {
                return;
            }
            idle.await;
        }
    }
    pub(in crate::host) fn subscribe(&self) -> watch::Receiver<Schedule> {
        self.schedule.subscribe()
    }
    pub(in crate::host) fn schedule(&self) -> Schedule {
        self.schedule.borrow().clone()
    }
    pub(in crate::host) async fn set_time(&self, time: String, now: i64) -> Result<(), HostError> {
        let _admission = self.admission.lock().await;
        if self.schedule().time == time {
            return Ok(());
        }
        let mut state = self.state().await?.unwrap_or(json!({}));
        state["schedule"] = json!({"timeOfDay":time,"changedAtMs":now});
        self.persist(state).await?;
        self.schedule.send_replace(Schedule {
            time,
            changed_at: Some(now),
            timezone: self.schedule().timezone,
        });
        Ok(())
    }
    pub(in crate::host) async fn set_timezone(&self, name: String) -> Result<(), HostError> {
        let timezone = tokio::task::spawn_blocking(move || crate::host::DateParser::new(&name))
            .await
            .map_err(HostError::from_error)?
            .map_err(HostError::from_error)?;
        self.schedule
            .send_modify(|schedule| schedule.timezone = Arc::new(timezone));
        Ok(())
    }
    pub(in crate::host) fn set_sink(&self, sink: MemoryEventSink) {
        *self.sink.write() = Some(sink);
    }
    pub(in crate::host) fn active(&self) -> Option<Value> {
        self.active.read().clone()
    }
    pub(in crate::host) fn reserve(&self, id: &str, trigger: &str) -> Value {
        let receipt = json!({"kind":"consolidation", "operation_id":id,
            "sequence":1,"phase":"running","trigger":trigger});
        *self.active.write() = Some(receipt.clone());
        receipt
    }
    pub(in crate::host) async fn writer_available(&self) -> Result<bool, HostError> {
        if !self
            .jobs
            .lock()
            .map_err(|_| HostError::new("memory_jobs_poisoned"))?
            .is_empty()
        {
            return Ok(false);
        }
        let coordinator = self.coordinator.clone();
        let lock = self.paths.consolidation_lock(&self.root);
        tokio::task::spawn_blocking(move || coordinator.writer_available(&lock))
            .await
            .map_err(HostError::from_error)?
            .map_err(HostError::from_error)
    }
    pub(in crate::host) async fn state(&self) -> Result<Option<Value>, HostError> {
        let root = self.root.clone();
        tokio::task::spawn_blocking(move || read_state(&root, "consolidation-cycle"))
            .await
            .map_err(HostError::from_error)?
    }
    pub(in crate::host) async fn persist(&self, state: Value) -> Result<(), HostError> {
        let root = self.root.clone();
        tokio::task::spawn_blocking(move || write_state(&root, "consolidation-cycle", &state))
            .await
            .map_err(HostError::from_error)?
    }
    pub(in crate::host) async fn view(&self) -> Result<Value, HostError> {
        let _admission = self.admission.lock().await;
        let state = self.state().await?;
        let last = state.filter(|s| s["lastRunAt"].is_string()).map(|s| {
            let mut last = json!({"at":s["lastRunAt"],"status":s["status"]});
            for key in ["message", "trigger", "late", "scheduledAt"] {
                if let Some(value) = s.get(key) {
                    last[key] = value.clone();
                }
            }
            last
        });
        Ok(json!({"active":self.active(),"last_run":last,"time_of_day":self.schedule().time}))
    }
    async fn publish(&self, value: Value) {
        let sink = self.sink.read().clone();
        if let Some(sink) = sink {
            let _ = sink(value).await;
        }
    }
    pub(in crate::host) async fn drive(
        &self,
        daily: &DailyCognitionJobs,
        receipt: Value,
        started: i64,
        day: Option<String>,
        cancellation: &CancellationToken,
    ) -> Result<(), HostError> {
        let _active = ActiveRun(self);
        self.publish(receipt.clone()).await;
        let id = receipt["operation_id"]
            .as_str()
            .ok_or("consolidation_receipt_invalid")?
            .to_owned();
        let result = daily.consolidation_cycle(id, started, cancellation).await;
        let _admission = self.admission.lock().await;
        // Shutdown preserves the scheduled intent, including its original run id and start.
        if result.is_err() && cancellation.is_cancelled() {
            return result;
        }
        let mut state = self.state().await?.unwrap_or(json!({}));
        state["lastRunAt"] = json!(iso_at(started));
        state["status"] = json!(if result.is_ok() { "ok" } else { "error" });
        state["trigger"] = receipt["trigger"].clone();
        state["runId"] = receipt["operation_id"].clone();
        state["late"] = json!(receipt["late"].as_bool().unwrap_or(false));
        state["scheduledAt"] = receipt["scheduledAt"].clone();
        if receipt["trigger"] == "scheduled" {
            state["scheduledHandledAtMs"] = json!(started);
        }
        state
            .as_object_mut()
            .ok_or("scheduler_state_invalid")?
            .remove("message");
        if let Some(day) = day {
            state["lastRunDate"] = json!(day);
        }
        if let Err(error) = &result {
            state["message"] = json!(error.message());
        }
        let persisted = self.persist(state).await;
        let mut terminal = receipt;
        terminal["sequence"] = json!(2);
        terminal["phase"] = json!(if result.is_ok() && persisted.is_ok() {
            "complete"
        } else {
            "failed"
        });
        self.publish(terminal).await;
        persisted?;
        result
    }
}

struct ActiveRun<'a>(&'a ConsolidationRunGate);
impl Drop for ActiveRun<'_> {
    fn drop(&mut self) {
        *self.0.active.write() = None;
        self.0.idle.notify_waiters();
    }
}
