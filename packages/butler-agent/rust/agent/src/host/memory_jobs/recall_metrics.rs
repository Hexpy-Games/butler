//! Source-compatible diagnostic recall events through the existing metric file owner.

use std::sync::Arc;

use serde_json::json;

use crate::cognition::{RecallMetric, RecallMetricSink};

use crate::operations::{MetricFiles, metrics_enabled};

pub(crate) struct RecallMetrics {
    files: Arc<MetricFiles>,
}

impl RecallMetrics {
    pub(crate) fn new(files: Arc<MetricFiles>) -> Self {
        Self { files }
    }
}

impl RecallMetricSink for RecallMetrics {
    fn record(&self, metric: RecallMetric) {
        if !metrics_enabled(self.files.data_root()) {
            return;
        }
        let (name, value, unit, duration_ms, dimensions) = match metric {
            RecallMetric::Stage {
                name,
                native_operation_sha256,
                duration_ms,
            } => (
                name,
                None,
                None,
                Some(duration_ms),
                json!({"native_operation_sha256": native_operation_sha256}),
            ),
            RecallMetric::CandidateRanking {
                native_operation_sha256,
                cue_sha256,
                generation_sha256,
                episode_sha256,
                candidate_rank,
                candidate_score,
                g_rank,
                g_score,
                v_rank,
                v_ann_distance,
                l_rank,
                l_score,
                c_rank,
                c_score,
                graph_executed,
                vector_executed,
                lexical_executed,
                context_executed,
            } => {
                let mut dimensions = json!({
                    "native_operation_sha256": native_operation_sha256,
                    "cue_sha256": cue_sha256,
                    "generation_sha256": generation_sha256,
                    "episode_sha256": episode_sha256,
                    "ranking_stage": "candidate",
                    "candidate_rank": candidate_rank,
                    "candidate_score": candidate_score,
                    "g_rank": g_rank, "g_score": g_score,
                    "v_rank": v_rank, "v_ann_distance": v_ann_distance,
                    "l_rank": l_rank, "l_score": l_score,
                    "c_rank": c_rank, "c_score": c_score,
                    "graph_executed": graph_executed,
                    "vector_executed": vector_executed,
                    "lexical_executed": lexical_executed,
                    "context_executed": context_executed,
                });
                if v_ann_distance.is_none() {
                    crate::json::object_mut(&mut dimensions).remove("v_ann_distance");
                }
                (
                    "recall_v2_ranking",
                    Some(candidate_score),
                    Some("score"),
                    None,
                    dimensions,
                )
            }
            RecallMetric::ReturnedRanking {
                native_operation_sha256,
                cue_sha256,
                generation_sha256,
                episode_sha256,
                candidate_rank,
                returned_rank,
                graph_executed,
                vector_executed,
                lexical_executed,
                context_executed,
            } => (
                "recall_v2_ranking",
                Some(returned_rank as f64),
                Some("rank"),
                None,
                json!({
                    "native_operation_sha256": native_operation_sha256,
                    "cue_sha256": cue_sha256,
                    "generation_sha256": generation_sha256,
                    "episode_sha256": episode_sha256,
                    "ranking_stage": "returned",
                    "candidate_rank": candidate_rank,
                    "returned_rank": returned_rank,
                    "graph_executed": graph_executed,
                    "vector_executed": vector_executed,
                    "lexical_executed": lexical_executed,
                    "context_executed": context_executed,
                }),
            ),
        };
        let mut event = json!({
            "schema": "butler.operational-metric.v1",
            "ts": chrono::Utc::now().timestamp_millis(),
            "category": "memory",
            "name": name,
            "status": "ok",
            "dimensions": dimensions,
            "rawTextStored": false,
        });
        if let Some(value) = value.filter(|value| value.is_finite()) {
            event["value"] = json!(value);
        }
        if let Some(unit) = unit {
            event["unit"] = json!(unit);
        }
        if let Some(duration) = duration_ms.filter(|value| value.is_finite()) {
            event["durationMs"] = json!(duration);
        }
        if let Ok(mut line) = serde_json::to_vec(&event) {
            line.push(b'\n');
            let _ = self.files.append_operational_event(&line);
        }
    }
}
