//! Adversarial summary producers: one call, deterministic projection, exact mandatory input.
use super::tests::{UnusedSummary, message};
use super::{
    compaction::CompactionState,
    serialization::{MessageProjection, messages_json},
    summary::{SummaryPort, SummaryRequest, SummarySizing},
};
use butler_turn::btcc::{
    ContextProjectionError, ModelRoundError, ModelRoundMessage, ModelRoundRole,
};
use std::{
    future::Future,
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};

struct Producer {
    output: Option<String>,
    calls: AtomicUsize,
}
impl SummaryPort for Producer {
    fn sizing(&self) -> Result<Option<SummarySizing<'_>>, ModelRoundError> {
        Ok(None)
    }
    fn summarize<'a>(
        &'a self,
        request: SummaryRequest<'a>,
    ) -> Pin<Box<dyn Future<Output = Result<String, ModelRoundError>> + Send + 'a>> {
        assert!(request.text.len() <= 1000);
        self.calls.fetch_add(1, Ordering::Relaxed);
        Box::pin(async move { self.output.clone().ok_or(ModelRoundError::Cancelled) })
    }
}
fn measure(messages: &[ModelRoundMessage]) -> Result<f64, ContextProjectionError> {
    messages_json(messages.iter(), MessageProjection::Exact)
        .map(|json| json.len() as f64)
        .map_err(ContextProjectionError::Contract)
}

pub(super) async fn bounded_deterministic_summaries() {
    let messages = [
        message(ModelRoundRole::User, "original objective"),
        message(
            ModelRoundRole::Assistant,
            &"untrusted old output 💡\\\" ".repeat(400),
        ),
        message(ModelRoundRole::User, "latest direction"),
    ];
    for output in [Some("💡\\\"한글 ".repeat(4096)), Some(String::new()), None] {
        let producer = Producer {
            output,
            calls: AtomicUsize::new(0),
        };
        let mut first = CompactionState::new(Arc::from([]));
        let mut second = CompactionState::new(Arc::from([]));
        let a = first
            .prepare(&messages, 1000.0, &measure, &producer)
            .await
            .unwrap();
        let b = second
            .prepare(&messages, 1000.0, &measure, &producer)
            .await
            .unwrap();
        assert_eq!(
            producer.calls.load(Ordering::Relaxed),
            2,
            "one call per compaction"
        );
        assert_eq!(
            a.messages, b.messages,
            "deterministic for identical producer output"
        );
        assert_eq!(a.identity, b.identity);
        let projected = a.messages.unwrap();
        assert!(measure(&projected).unwrap() <= 1000.0);
        assert_eq!(projected.first().unwrap(), &messages[0]);
        assert_eq!(projected.last().unwrap(), &messages[2]);
        assert!(
            projected
                .iter()
                .any(|m| m.content.contains("read_operation_results"))
        );
        assert!(a.save_record.unwrap().summary.len() <= 120);
    }
    // Impossible mandatory input fails without spending a model call.
    let mut state = CompactionState::new(Arc::from([]));
    let error = state
        .prepare(&messages, 1.0, &measure, &UnusedSummary)
        .await
        .err()
        .unwrap();
    assert!(matches!(error, ContextProjectionError::Contract(_)));
    // Fitting mandatory input without room for even the history marker must
    // fail explicitly instead of silently dropping all historical context.
    let capacity = measure(&[messages[0].clone(), messages[2].clone()]).unwrap() + 1.0;
    let producer = Producer {
        output: None,
        calls: AtomicUsize::new(0),
    };
    let mut state = CompactionState::new(Arc::from([]));
    let error = state
        .prepare(&messages, capacity, &measure, &producer)
        .await
        .err()
        .unwrap();
    assert!(matches!(error, ContextProjectionError::Contract(_)));
    assert!(producer.calls.load(Ordering::Relaxed) <= 1);
    // Local and hosted summarizers share the hard cap; no 16k output floor.
    assert_eq!(super::summary_output_tokens(None, 120), Some(30.0));
    assert_eq!(super::summary_output_tokens(None, 4), Some(1.0));
}
