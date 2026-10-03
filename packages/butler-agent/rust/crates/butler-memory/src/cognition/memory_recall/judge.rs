//! Frozen listwise recall ranking. Only summary prefixes cross the model boundary.
use super::{
    metrics::{self, RecallMetric, RecallMetricSink},
    query::PreparedSelection,
    selection::Selection,
};
use crate::cognition::recall::RecallRequest;
mod model;
pub use model::{ConfiguredRecallJudge, RecallJudgeModelFuture, RecallJudgeModelSource};
use serde::Serialize;
use std::{
    future::Future,
    pin::Pin,
    sync::Mutex,
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

/// One local candidate number and at most 150 Unicode characters.
#[derive(Serialize)]
pub struct RecallJudgeCandidate {
    /// One-based number, local to this recall.
    pub candidate: usize,
    /// Prefix of the stored episode summary.
    pub summary: String,
}

/// Validated locally before fusion; usage is provider-reported, never estimated.
pub struct RecallJudgeResult {
    /// Distinct candidate numbers, most relevant first.
    pub ranked: Vec<usize>,
    /// Billable input reported by the provider.
    pub input_tokens: Option<f64>,
    /// Output usage reported by the provider.
    pub output_tokens: Option<f64>,
}

/// A failure code contains no provider payload or conversation text.
pub struct RecallJudgeUnavailable;
/// Cancellable host ranking operation.
pub type RecallJudgeFuture<'a> = Pin<
    Box<dyn Future<Output = Result<Option<RecallJudgeResult>, RecallJudgeUnavailable>> + Send + 'a>,
>;

/// The host resolves the memory model per recall; None means the user disabled judging.
pub trait RecallJudgePort: Send + Sync {
    /// Rank these summary-only candidates; None means disabled.
    fn rank<'a>(
        &'a self,
        question: &'a str,
        candidates: &'a [RecallJudgeCandidate],
        cancellation: CancellationToken,
    ) -> RecallJudgeFuture<'a>;
}

pub(super) fn gate(selected: &Selection) -> bool {
    let [first, second, ..] = selected.metrics.as_slice() else {
        return false;
    };
    first.l_score < 0.15 && first.candidate_score - second.candidate_score < 0.05
}

/// 8s is the owner-approved request deadline above measured 6.98s p95.
/// No retry, no lease, no resident model and no idle work.
pub(super) async fn run(
    input: &RecallRequest,
    prepared: &mut PreparedSelection,
    port: Option<&dyn RecallJudgePort>,
    sink: Option<&dyn RecallMetricSink>,
    shutdown: &CancellationToken,
    caller: &CancellationToken,
) {
    let fired = gate(&prepared.selected);
    let started = Instant::now();
    let mut judged = false;
    let mut input_tokens = None;
    let mut output_tokens = None;
    if fired && let Some(port) = port {
        let cancel = shutdown.child_token();
        let _guard = cancel.clone().drop_guard();
        let result = tokio::select! {
            () = shutdown.cancelled() => return,
            () = caller.cancelled() => return,
            result = tokio::time::timeout(Duration::from_secs(8), port.rank(&input.runtime.current_user_message, &prepared.candidates, cancel)) => result,
        };
        match result {
            Ok(Ok(Some(reply))) => {
                input_tokens = reply.input_tokens;
                output_tokens = reply.output_tokens;
                judged = fuse(&mut prepared.selected, &reply.ranked);
                if judged {
                    prepared.ranking = Some(reply.ranked);
                } else {
                    diagnostic();
                }
            }
            Ok(Ok(None)) => {}
            _ => diagnostic(),
        }
    }
    if let Some(sink) = sink {
        sink.record(RecallMetric::Judge {
            native_operation_sha256: metrics::sha(&input.runtime.native_operation_id),
            gate_fired: fired,
            judged,
            duration_ms: started.elapsed().as_secs_f64() * 1000.0,
            input_tokens,
            output_tokens,
        });
    }
}

pub(super) fn fuse(selected: &mut Selection, ranked: &[usize]) -> bool {
    let n = selected.ranked.len().min(15);
    let mut judge_ranks = std::collections::HashMap::new();
    if ranked.len() > 10 {
        return false;
    }
    for (rank, &candidate) in ranked.iter().enumerate() {
        if candidate == 0 || candidate > n || judge_ranks.insert(candidate, rank + 1).is_some() {
            return false;
        }
    }
    let scores = selected
        .ranked
        .iter()
        .take(n)
        .enumerate()
        .map(|(i, row)| {
            let score = 1.0 / (61 + i) as f64
                + judge_ranks
                    .get(&(i + 1))
                    .map_or(0.0, |rank| 1.0 / (60 + rank) as f64);
            (row.input.episode_id.clone(), score)
        })
        .collect::<std::collections::HashMap<_, _>>();
    if let Some(offered) = selected.ranked.get_mut(..n) {
        // Stable sort preserves first-stage ties; the rest never moves.
        offered.sort_by(|a, b| {
            let score = |row: &crate::cognition::recall::RankedEpisode| {
                scores
                    .get(&row.input.episode_id)
                    .copied()
                    .unwrap_or_default()
            };
            score(b).total_cmp(&score(a))
        });
    }
    true
}

fn diagnostic() {
    static LAST: Mutex<Option<Instant>> = Mutex::new(None);
    let Ok(mut last) = LAST.lock() else {
        return;
    };
    if last.is_none_or(|time| time.elapsed() >= Duration::from_secs(60)) {
        *last = Some(Instant::now());
        butler_core::diagnostic!(
            "[recall-judge] model check unavailable; retaining first-stage order"
        );
    }
}
