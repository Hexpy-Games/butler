//! Reuse a judgment only for identical evidence after selecting fresh candidates.
use super::{PreparedSelection, Selection};
use crate::cognition::memory_recall::{details::DetailPin, judge};
use crate::cognition::{CognitionResult, graph::GraphRecallReader};

#[derive(PartialEq, Eq)]
pub(in crate::cognition::memory_recall) struct CandidateStamp {
    episode: String,
    revision: String,
    source_hash: String,
    summary_status: String,
    summary: String,
}

pub(super) fn candidates(
    selected: &Selection,
    graph: &GraphRecallReader,
) -> CognitionResult<(Vec<judge::RecallJudgeCandidate>, Vec<CandidateStamp>)> {
    let mut candidates = Vec::new();
    let mut stamps = Vec::new();
    for (index, row) in selected.ranked.iter().take(15).enumerate() {
        let stamp = graph.connection()?.query_row(
            "SELECT current_revision,source_hash,summary_status,substr(summary,1,150) FROM memory_chunks WHERE memory_chunk_id=?1",
            [&row.input.episode_id],
            |record| Ok(CandidateStamp {
                episode: row.input.episode_id.clone(),
                revision: record.get(0)?,
                source_hash: record.get(1)?,
                summary_status: record.get(2)?,
                summary: record.get::<_, Option<String>>(3)?.unwrap_or_default(),
            }),
        ).map_err(crate::cognition::graph::db_error)?;
        candidates.push(judge::RecallJudgeCandidate {
            candidate: index + 1,
            summary: stamp.summary.clone(),
        });
        stamps.push(stamp);
    }
    Ok((candidates, stamps))
}

pub(super) fn reapply(
    prepared: &PreparedSelection,
    pin: &DetailPin,
    selected: &mut Selection,
    graph: &GraphRecallReader,
) -> CognitionResult<()> {
    let Some(ranking) = &prepared.ranking else {
        return Ok(());
    };
    if !prepared.pin.same_source_identity(pin) || !judge::gate(selected) {
        return Ok(());
    }
    let (_, stamps) = candidates(selected, graph)?;
    if prepared.stamps == stamps {
        judge::fuse(selected, ranking);
    }
    Ok(())
}
