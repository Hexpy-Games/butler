//! Request-bound, hash-only operational metric projection.

use sha2::{Digest, Sha256};

#[expect(
    clippy::struct_excessive_bools,
    reason = "one independent flag per recall channel"
)]
#[derive(Clone, Copy)]
pub(super) struct Executed {
    pub graph: bool,
    pub vector: bool,
    pub lexical: bool,
    pub context: bool,
}

pub(super) struct Candidate {
    pub episode_id: String,
    pub candidate_score: f64,
    pub g_rank: f64,
    pub g_score: f64,
    pub v_rank: f64,
    pub v_ann_distance: Option<f64>,
    pub l_rank: f64,
    pub l_score: f64,
    pub c_rank: f64,
    pub c_score: f64,
}

/// An operational recall metric. Every identifier is hashed; no text is recorded.
pub enum RecallMetric {
    /// How long a recall stage took.
    Stage {
        /// Stage name.
        name: &'static str,
        /// Hash of the recall operation.
        native_operation_sha256: String,
        /// Duration in milliseconds.
        duration_ms: f64,
    },
    /// The rank of one candidate episode across the recall channels.
    CandidateRanking {
        /// Hash of the recall operation.
        native_operation_sha256: String,
        /// Hash of the recall cue.
        cue_sha256: String,
        /// Hash of the memory generation.
        generation_sha256: String,
        /// Hash of the episode.
        episode_sha256: String,
        /// Rank after fusion.
        candidate_rank: usize,
        /// Fused score.
        candidate_score: f64,
        /// Graph channel rank.
        g_rank: f64,
        /// Graph channel score.
        g_score: f64,
        /// Vector channel rank.
        v_rank: f64,
        /// Vector nearest-neighbour distance, when the episode was a vector hit.
        v_ann_distance: Option<f64>,
        /// Lexical channel rank.
        l_rank: f64,
        /// Lexical channel score.
        l_score: f64,
        /// Context channel rank.
        c_rank: f64,
        /// Context channel score.
        c_score: f64,
        /// The graph channel ran.
        graph_executed: bool,
        /// The vector channel ran.
        vector_executed: bool,
        /// The lexical channel ran.
        lexical_executed: bool,
        /// The context channel ran.
        context_executed: bool,
    },
    /// Where a returned episode ranked before and after selection.
    ReturnedRanking {
        /// Hash of the recall operation.
        native_operation_sha256: String,
        /// Hash of the recall cue.
        cue_sha256: String,
        /// Hash of the memory generation.
        generation_sha256: String,
        /// Hash of the episode.
        episode_sha256: String,
        /// Rank after fusion.
        candidate_rank: usize,
        /// Rank in the returned results.
        returned_rank: usize,
        /// The graph channel ran.
        graph_executed: bool,
        /// The vector channel ran.
        vector_executed: bool,
        /// The lexical channel ran.
        lexical_executed: bool,
        /// The context channel ran.
        context_executed: bool,
    },
}

/// Receives recall metrics.
pub trait RecallMetricSink: Send + Sync {
    /// Records one metric.
    fn record(&self, metric: RecallMetric);
}

pub(super) fn sha(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

pub(super) fn candidate(
    input: &crate::cognition::recall::RecallRequest,
    generation: &str,
    rank: usize,
    value: &Candidate,
    executed: Executed,
) -> RecallMetric {
    RecallMetric::CandidateRanking {
        native_operation_sha256: sha(&input.runtime.native_operation_id),
        cue_sha256: sha(&input.cue),
        generation_sha256: sha(generation),
        episode_sha256: sha(&value.episode_id),
        candidate_rank: rank,
        candidate_score: value.candidate_score,
        g_rank: value.g_rank,
        g_score: value.g_score,
        v_rank: value.v_rank,
        v_ann_distance: value.v_ann_distance,
        l_rank: value.l_rank,
        l_score: value.l_score,
        c_rank: value.c_rank,
        c_score: value.c_score,
        graph_executed: executed.graph,
        vector_executed: executed.vector,
        lexical_executed: executed.lexical,
        context_executed: executed.context,
    }
}

pub(super) fn returned(
    input: &crate::cognition::recall::RecallRequest,
    generation: &str,
    candidate_rank: usize,
    returned_rank: usize,
    episode_id: &str,
    executed: Executed,
) -> RecallMetric {
    RecallMetric::ReturnedRanking {
        native_operation_sha256: sha(&input.runtime.native_operation_id),
        cue_sha256: sha(&input.cue),
        generation_sha256: sha(generation),
        episode_sha256: sha(episode_id),
        candidate_rank,
        returned_rank,
        graph_executed: executed.graph,
        vector_executed: executed.vector,
        lexical_executed: executed.lexical,
        context_executed: executed.context,
    }
}
