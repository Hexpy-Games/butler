//! Tracked bounded host lane for passive metrics and durable completion jobs.

use std::path::Path;
use std::sync::Arc;
use std::thread::JoinHandle;

use tokio::sync::{Mutex, mpsc, oneshot};

use crate::cognition::{CognitionPathEnvironment, CompletionNotice, CompletionPublisher};
use crate::conversation::{
    AdmissionMetric, AdmissionSource, CompletionMetric, CompletionObservation,
    ConversationAdmissionObserver, ConversationCode, ConversationError, ConversationIdentityClock,
    ConversationObserverFuture,
};
use crate::operations::{AdmissionMeasure, ConversationMetrics, MetricFiles};

const CAPACITY: usize = 64;

enum Job {
    Admission(
        AdmissionMetric,
        oneshot::Sender<Result<(), ConversationError>>,
    ),
    Completion(
        CompletionNotice,
        oneshot::Sender<Result<(), ConversationError>>,
    ),
    Metric(
        CompletionMetric,
        oneshot::Sender<Result<(), ConversationError>>,
    ),
}

struct State {
    sender: Option<mpsc::Sender<Job>>,
    worker: Option<JoinHandle<()>>,
}

pub(crate) struct NativeConversationObserver {
    state: Mutex<State>,
}

impl NativeConversationObserver {
    pub(crate) fn new(
        data_root: &Path,
        paths: &CognitionPathEnvironment,
        clock: Arc<dyn ConversationIdentityClock>,
        metric_files: Arc<MetricFiles>,
    ) -> std::io::Result<Self> {
        let (sender, mut receiver) = mpsc::channel(CAPACITY);
        let now_iso = Arc::new(move || clock.now_iso());
        let publisher = CompletionPublisher::new(data_root, paths, now_iso);
        let metrics = ConversationMetrics::new(metric_files);
        let worker = std::thread::Builder::new()
            .name("butler-completion-observer".into())
            .spawn(move || {
                while let Some(job) = receiver.blocking_recv() {
                    match job {
                        Job::Admission(input, result) => {
                            metrics.admission(AdmissionMeasure {
                                session_id: &input.session_id,
                                session_role: &input.session_role,
                                source: match input.source {
                                    AdmissionSource::Gateway => "gateway",
                                    AdmissionSource::RuntimeTurnEvent => "runtime_turn_event",
                                },
                                event_kind: &input.event_kind,
                                admitted: input.admitted,
                                class_name: input.class_name,
                                reason: input.reason,
                            });
                            let _ = result.send(Ok(()));
                        }
                        Job::Completion(input, result) => {
                            let outcome = publisher.publish(&input).map_err(|error| {
                                ConversationError::port(error.code, error.message.clone(), error)
                            });
                            let _ = result.send(outcome);
                        }
                        Job::Metric(input, result) => {
                            metrics.completion(input.project_scoped, input.succeeded);
                            let _ = result.send(Ok(()));
                        }
                    }
                }
            })?;
        Ok(Self {
            state: Mutex::new(State {
                sender: Some(sender),
                worker: Some(worker),
            }),
        })
    }

    async fn submit(
        &self,
        job: impl FnOnce(oneshot::Sender<Result<(), ConversationError>>) -> Job,
    ) -> Result<(), ConversationError> {
        let (reply, result) = oneshot::channel();
        let state = self.state.lock().await;
        let sender = state.sender.as_ref().ok_or_else(closed)?;
        sender.send(job(reply)).await.map_err(|_| closed())?;
        drop(state);
        result.await.map_err(|_| closed())?
    }

    /// Stops admission, drains already accepted jobs, and joins the owner.
    pub(crate) async fn close(&self) -> Result<(), ConversationError> {
        let mut state = self.state.lock().await;
        state.sender.take();
        if let Some(worker) = state.worker.take() {
            tokio::task::spawn_blocking(move || worker.join())
                .await
                .map_err(|error| {
                    ConversationError::new(
                        ConversationCode::ConversationObserverJoinFailed,
                        error.to_string(),
                    )
                    .with_source(error)
                })?
                .map_err(|_| closed())?;
        }
        Ok(())
    }
}

impl ConversationAdmissionObserver for NativeConversationObserver {
    fn admission_metric(&self, metric: AdmissionMetric) -> ConversationObserverFuture<'_> {
        Box::pin(async move { self.submit(|reply| Job::Admission(metric, reply)).await })
    }

    fn completion_observation(
        &self,
        observation: CompletionObservation,
    ) -> ConversationObserverFuture<'_> {
        let input = CompletionNotice {
            project_id: observation.project_id,
            runtime_session_id: observation.runtime_session_id,
            conversation_session_id: observation.conversation_session_id,
            conversation_turn_id: observation.conversation_turn_id,
            inbound_message_id: observation.inbound_message_id,
            outbound_message_id: observation.outbound_message_id,
            outcome_generation: observation.outcome_generation,
            completed_at: observation.completed_at,
        };
        Box::pin(async move { self.submit(|reply| Job::Completion(input, reply)).await })
    }

    fn completion_metric(&self, metric: CompletionMetric) -> ConversationObserverFuture<'_> {
        Box::pin(async move { self.submit(|reply| Job::Metric(metric, reply)).await })
    }
}

fn closed() -> ConversationError {
    ConversationError::new(
        ConversationCode::ConversationObserverClosed,
        "conversation observer is closed",
    )
}

#[cfg(test)]
mod tests;
