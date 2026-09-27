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
pub struct HistoricalOriginReport {
    pub(crate) applied: usize,
    pub(crate) unchanged: usize,
    pub(crate) unknown: usize,
    pub(crate) pending: usize,
}

/// Classifies the origin of every unclassified historical user and assistant
/// message from durable evidence, page by page within one minute.
pub async fn classify_historical_origins(
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
    let scan = Scan {
        data_root: &data_root,
        store,
        cancellation,
        started,
    };
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
            scan.classify_page(&rows, role, &mut report).await?;
            if rows.len() < 100 {
                break;
            }
        }
    }
    Ok(report)
}

/// One classification pass over the conversation store.
struct Scan<'a> {
    data_root: &'a PathBuf,
    store: &'a AgentConversationStore,
    cancellation: &'a CancellationToken,
    started: Instant,
}

impl Scan<'_> {
    /// Classifies the page's messages of `role`; user messages are matched
    /// against the page's source evidence, read once per page.
    async fn classify_page(
        &self,
        rows: &[HistoricalOriginCandidate],
        role: ConversationRole,
        report: &mut HistoricalOriginReport,
    ) -> ConversationResult<()> {
        let facts = match role {
            ConversationRole::User => self.user_facts(rows).await?,
            _ => Vec::new(),
        };
        let mut user_facts = facts.iter();
        for row in rows.iter().filter(|row| row.role == role) {
            check(self.cancellation, self.started)?;
            if role != ConversationRole::User {
                classify_assistant(self.store, row, report).await?;
                continue;
            }
            // read_page returns one fact set per user row, in order.
            let Some(facts) = user_facts.next() else {
                return Err(unavailable());
            };
            classify_user(self.store, row, facts, report).await?;
        }
        Ok(())
    }

    async fn user_facts(
        &self,
        rows: &[HistoricalOriginCandidate],
    ) -> ConversationResult<Vec<evidence::UserEvidence>> {
        let user_rows = rows
            .iter()
            .filter(|row| row.role == ConversationRole::User)
            .cloned()
            .collect::<Vec<_>>();
        if user_rows.is_empty() {
            return Ok(Vec::new());
        }
        let root = self.data_root.clone();
        let page_cancellation = self.cancellation.clone();
        let started = self.started;
        tokio::task::spawn_blocking(move || {
            evidence::read_page(&root, &user_rows, started, &page_cancellation)
        })
        .await
        .map_err(|source| unavailable().with_source(source))?
    }
}

/// A user message delivered through the subsession outbox is internal
/// control (correcting an earlier classification); otherwise an unclassified
/// one is classified from its source evidence.
async fn classify_user(
    store: &AgentConversationStore,
    row: &HistoricalOriginCandidate,
    facts: &evidence::UserEvidence,
    report: &mut HistoricalOriginReport,
) -> ConversationResult<()> {
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
        return record(store, row, decision, Correction::InternalOrigin, report).await;
    }
    if row.origin_version.is_some() {
        report.unchanged += 1;
        return Ok(());
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
    record(store, row, decision, Correction::None, report).await
}

/// Whether a classification may replace an existing one.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Correction {
    None,
    /// Correct an earlier classification to internal control.
    InternalOrigin,
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
    let correction = if correct_internal {
        Correction::InternalOrigin
    } else {
        Correction::None
    };
    record(store, row, decision, correction, report).await
}

async fn record(
    store: &AgentConversationStore,
    row: &HistoricalOriginCandidate,
    decision: ConversationOriginDecision,
    correction: Correction,
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
            correct_internal_origin: correction == Correction::InternalOrigin,
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
