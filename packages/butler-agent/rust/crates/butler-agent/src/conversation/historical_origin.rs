//! Source-compatible metadata-only origin recovery before rebuild inventory.

mod evidence;

use std::{
    path::PathBuf,
    time::{Duration, Instant},
};

use tokio_util::sync::CancellationToken;

use super::{
    AgentConversationStore, ConversationError, ConversationOriginDecision,
    ConversationOriginEvidence, ConversationOriginFacts, ConversationOriginKind,
    ConversationResult, ConversationRole, HistoricalOriginCandidate,
    RecordOriginClassificationInput, RecordOriginClassificationResult,
    classify_conversation_origin,
};
use crate::conversation::ConversationCode;

#[derive(Default)]
pub(crate) struct HistoricalOriginReport {
    pub(crate) applied: usize,
    pub(crate) unchanged: usize,
    pub(crate) unknown: usize,
    pub(crate) pending: usize,
}

pub(crate) async fn classify_historical_origins(
    data_root: PathBuf,
    store: &AgentConversationStore,
    cancellation: &CancellationToken,
) -> ConversationResult<HistoricalOriginReport> {
    let started = Instant::now();
    let root = data_root.clone();
    let validation_cancel = cancellation.clone();
    tokio::task::spawn_blocking(move || {
        evidence::validate_outbox(&root, started, &validation_cancel)
    })
    .await
    .map_err(|source| unavailable().with_source(source))??;
    let mut report = HistoricalOriginReport::default();
    for role in [ConversationRole::User, ConversationRole::Assistant] {
        let mut after = None;
        loop {
            check(cancellation, started)?;
            let rows = store
                .read_origin_candidates_page(after, Some(100.0))
                .await?;
            if rows.is_empty() {
                break;
            }
            after = rows.last().map(|row| row.message_id.clone());
            let user_rows = if role == ConversationRole::User {
                rows.iter()
                    .filter(|row| row.role == ConversationRole::User)
                    .cloned()
                    .collect::<Vec<_>>()
            } else {
                Vec::new()
            };
            let facts = if user_rows.is_empty() {
                Vec::new()
            } else {
                let root = data_root.clone();
                let page_cancellation = cancellation.clone();
                tokio::task::spawn_blocking(move || {
                    evidence::read_page(&root, &user_rows, started, &page_cancellation)
                })
                .await
                .map_err(|source| unavailable().with_source(source))??
            };
            let mut user = 0;
            for row in rows.iter().filter(|row| row.role == role) {
                check(cancellation, started)?;
                if role == ConversationRole::User {
                    // read_page returns one fact set per user row, in order.
                    let Some(facts) = facts.get(user) else {
                        return Err(unavailable());
                    };
                    user += 1;
                    if let Some(outbox) = facts
                        .outbox
                        .clone()
                        .filter(|_| row.origin_kind != ConversationOriginKind::InternalControl)
                    {
                        let decision = classify_conversation_origin(
                            store.collation().as_ref(),
                            ConversationOriginFacts {
                                reference: row.source_ref.clone(),
                                public_ingress: false,
                                internal_control: true,
                                evidence_available: true,
                                evidence: vec![outbox],
                            },
                        );
                        record(store, row, decision, true, &mut report).await?;
                        continue;
                    }
                    if row.origin_version.is_some() {
                        report.unchanged += 1;
                        continue;
                    }
                    let decision = classify_conversation_origin(
                        store.collation().as_ref(),
                        ConversationOriginFacts {
                            reference: row.source_ref.clone(),
                            public_ingress: facts.public_ingress,
                            internal_control: facts.internal_control,
                            evidence_available: facts.available,
                            evidence: facts.evidence.clone(),
                        },
                    );
                    record(store, row, decision, false, &mut report).await?;
                } else {
                    classify_assistant(store, row, &mut report).await?;
                }
            }
            if rows.len() < 100 {
                break;
            }
        }
    }
    Ok(report)
}

async fn classify_assistant(
    store: &AgentConversationStore,
    row: &HistoricalOriginCandidate,
    report: &mut HistoricalOriginReport,
) -> ConversationResult<()> {
    if row.turn_id.is_some() && row.outcome_id.is_none() {
        report.pending += 1;
        return Ok(());
    }
    let request = match &row.outcome_request_message_id {
        Some(id) => store.read_message_by_id(id).await?,
        None => None,
    };
    let request = request.as_ref().map(|item| &item.message);
    let exact = row.outcome_public_assistant_message_id.as_deref() == Some(&row.message_id)
        && request
            .is_some_and(|item| item.session_id == row.session_id && item.turn_id == row.turn_id);
    let request_evidence: Vec<ConversationOriginEvidence> = request
        .and_then(|item| item.origin_evidence_json.as_deref())
        .map(serde_json::from_str)
        .transpose()
        .map_err(ConversationError::json)?
        .unwrap_or_default();
    let correct_internal = exact
        && request.is_some_and(|item| item.origin_kind == ConversationOriginKind::InternalControl)
        && request_evidence
            .iter()
            .any(|item| item.kind == "subsession" && item.sha256.is_some());
    if row.origin_version.is_some()
        && (!correct_internal || row.origin_kind == ConversationOriginKind::InternalControl)
    {
        report.unchanged += 1;
        return Ok(());
    }
    let public =
        exact && request.is_some_and(|item| item.origin_kind == ConversationOriginKind::UserInput);
    let internal = exact
        && request.is_some_and(|item| item.origin_kind == ConversationOriginKind::InternalControl);
    let mut evidence = if correct_internal {
        request_evidence
    } else {
        Vec::new()
    };
    if let Some(outcome) = &row.outcome_id {
        evidence.push(ConversationOriginEvidence {
            kind: "turn_outcome".into(),
            reference: outcome.clone(),
            sha256: None,
        });
    }
    let mut decision = classify_conversation_origin(
        store.collation().as_ref(),
        ConversationOriginFacts {
            reference: row.source_ref.clone(),
            public_ingress: public,
            internal_control: internal,
            evidence_available: row.outcome_id.is_none()
                || row.turn_id.is_none()
                || row.outcome_request_message_id.is_none()
                || request.is_some_and(|item| item.origin_version.is_some()),
            evidence,
        },
    );
    if decision.kind == ConversationOriginKind::UserInput {
        decision.kind = ConversationOriginKind::AssistantPublic;
        decision.reason = "verified_public_outcome".into();
    }
    record(store, row, decision, correct_internal, report).await
}

async fn record(
    store: &AgentConversationStore,
    row: &HistoricalOriginCandidate,
    decision: ConversationOriginDecision,
    correct_internal: bool,
    report: &mut HistoricalOriginReport,
) -> ConversationResult<()> {
    if !decision.complete {
        return Err(unavailable());
    }
    let unknown = decision.kind == ConversationOriginKind::Unknown;
    match store
        .record_origin_classification(RecordOriginClassificationInput {
            candidate: row.clone(),
            decision,
            correct_internal_origin: correct_internal,
        })
        .await?
    {
        RecordOriginClassificationResult::Applied => report.applied += 1,
        RecordOriginClassificationResult::Unchanged => report.unchanged += 1,
        RecordOriginClassificationResult::SourceChanged => {
            return Err(ConversationError::new(
                ConversationCode::MemorySourceChanged,
                "canonical candidate changed",
            ));
        }
        RecordOriginClassificationResult::ClassificationConflict => {
            return Err(ConversationError::new(
                ConversationCode::MemoryOriginClassificationConflict,
                "origin classification conflicts",
            ));
        }
    }
    if unknown {
        report.unknown += 1;
    }
    Ok(())
}

fn check(cancellation: &CancellationToken, started: Instant) -> ConversationResult<()> {
    if cancellation.is_cancelled() || started.elapsed() >= Duration::from_secs(60) {
        Err(unavailable())
    } else {
        Ok(())
    }
}
fn unavailable() -> ConversationError {
    ConversationError::new(
        ConversationCode::MemoryOriginEvidenceUnavailable,
        "historical origin evidence unavailable",
    )
}
