//! Canonical Conversation inventory in source scan order, with bounded page storage.

mod candidate;
mod coverage;
mod filter;
mod sync;

use std::{cmp::Ordering, collections::HashSet};

use indexmap::IndexMap;

pub(in crate::cognition) use candidate::{
    CandidateKind, EligibleSource, FaultScope, InventoryCandidate, SourceFault, faulted,
    recovered_or_fault, source_key, turn as turn_candidate, turn_or_fault,
};
pub(in crate::cognition) use coverage::{CoverageRead, InventoryCoverage, inventory_coverage};
pub(in crate::cognition) use filter::RecallFilter;
pub(in crate::cognition) use sync::{sync_needed, sync_step};

use crate::cognition::recall::RecallRequest;
use crate::cognition::{
    CognitionError, CognitionResult, MEMORY_SOURCE_WINDOW_BYTES, split_historical_source_spans,
};
use butler_turn::conversation::{
    ConversationOriginKind, ConversationSourceReader, decode_message_scalars,
};

use super::identity::{RevisionTail, episode_revision, projection_hash, recovered_parts_hash};
use crate::cognition::CognitionCode;

#[derive(Clone, Debug)]
pub(in crate::cognition) struct CanonicalInventoryEntry {
    pub episode_id: String,
    pub revision: String,
    pub source_unit_count: usize,
    #[allow(
        dead_code,
        reason = "live canonical recall inventory retained outside generation simplification"
    )]
    pub source_ids: Vec<String>,
    #[allow(
        dead_code,
        reason = "live canonical recall inventory retained outside generation simplification"
    )]
    pub source_hashes: Vec<String>,
    #[allow(
        dead_code,
        reason = "live canonical recall inventory retained outside generation simplification"
    )]
    pub origin_kinds: Vec<String>,
}

#[derive(Debug)]
pub(in crate::cognition) struct CanonicalInventory {
    pub entries: Vec<CanonicalInventoryEntry>,
    #[allow(
        dead_code,
        reason = "live canonical recall inventory retained outside generation simplification"
    )]
    pub exclusions: IndexMap<String, usize>,
    pub partial: bool,
    pub available: bool,
}

pub(in crate::cognition) fn read_canonical_inventory(
    reader: Option<&ConversationSourceReader>,
    input: &RecallRequest,
    deadline_at: i64,
    parse_date: &dyn Fn(&str) -> f64,
    compare_locale: &dyn Fn(&str, &str) -> Ordering,
    mut now_millis: impl FnMut() -> i64,
) -> CognitionResult<CanonicalInventory> {
    let Some(reader) = reader else {
        return Ok(CanonicalInventory {
            entries: Vec::new(),
            exclusions: IndexMap::from([("canonical_reader_unavailable".into(), 1)]),
            partial: true,
            available: false,
        });
    };
    let mut scan = Scan {
        reader,
        filter: RecallFilter { input, parse_date },
        deadline_at,
        now_millis: &mut now_millis,
        entries: Vec::new(),
        exclusions: IndexMap::new(),
        partial: false,
    };
    let mut recovered_after = None;
    scan.recovered_page(&mut recovered_after, 64)?;
    let mut outcome_after = None;
    loop {
        if scan.deadline() {
            scan.partial = true;
            break;
        }
        let outcomes = reader
            .read_recall_outcome_page(outcome_after.as_deref(), Some(500))
            .map_err(unavailable)?;
        if outcomes.is_empty() {
            break;
        }
        let page_len = outcomes.len();
        for outcome in outcomes {
            if scan.deadline() {
                scan.partial = true;
                break;
            }
            outcome_after = Some(outcome.id.clone());
            scan.outcome(&outcome)?;
        }
        if scan.partial || page_len < 500 {
            break;
        }
    }
    while !scan.partial {
        if scan.deadline() {
            scan.partial = true;
            break;
        }
        if scan.recovered_page(&mut recovered_after, 500)? < 500 {
            break;
        }
    }
    scan.entries
        .sort_by(|a, b| compare_locale(&a.episode_id, &b.episode_id));
    Ok(CanonicalInventory {
        entries: scan.entries,
        exclusions: scan.exclusions,
        partial: scan.partial,
        available: true,
    })
}

struct Scan<'a> {
    reader: &'a ConversationSourceReader,
    filter: RecallFilter<'a>,
    deadline_at: i64,
    now_millis: &'a mut dyn FnMut() -> i64,
    entries: Vec<CanonicalInventoryEntry>,
    exclusions: IndexMap<String, usize>,
    partial: bool,
}

impl Scan<'_> {
    fn deadline(&mut self) -> bool {
        (self.now_millis)() >= self.deadline_at
    }
    fn exclude(&mut self, code: &str) {
        *self.exclusions.entry(code.to_owned()).or_default() += 1;
    }
    fn recovered_page(
        &mut self,
        after: &mut Option<String>,
        limit: usize,
    ) -> CognitionResult<usize> {
        let messages = self
            .reader
            .read_recovered_source_page(after.as_deref(), Some(limit))
            .map_err(unavailable)?;
        let len = messages.len();
        for message in messages {
            if self.deadline() {
                self.partial = true;
                break;
            }
            *after = Some(message.message.id.clone());
            let session = self
                .reader
                .read_session(&message.message.session_id)
                .map_err(unavailable)?;
            if !self.filter.session_admitted(session.as_ref())
                || self.filter.after_cutoff(&message.message.created_at)
            {
                self.exclude("scope_or_time");
                continue;
            }
            if !self.filter.time_contains(&message.message.created_at) {
                continue;
            }
            let scalars = decode_message_scalars(&message);
            if scalars.is_empty() {
                self.exclude("source_text_missing");
                continue;
            }
            let source_hash = recovered_parts_hash(&message).map_err(unavailable)?;
            let episode_id = candidate::message_episode_id(&message.message.id)?;
            self.entries.push(entry(
                &episode_id,
                &scalars,
                &RevisionTail::SourceHash(source_hash),
            )?);
        }
        Ok(len)
    }
    /// Adds the turn of one recall outcome when its session is in scope,
    /// the turn is terminal and its messages are eligible and in time.
    fn outcome(
        &mut self,
        outcome: &butler_turn::conversation::RecallOutcomeRow,
    ) -> CognitionResult<()> {
        let session = self
            .reader
            .read_session(&outcome.session_id)
            .map_err(unavailable)?;
        if !self.filter.session_admitted(session.as_ref()) {
            self.exclude("scope_or_session");
            return Ok(());
        }
        let messages = match candidate::turn_messages(self.reader, outcome)? {
            Ok(messages) => messages,
            Err(Some(exclusion)) => {
                self.exclude(exclusion);
                return Ok(());
            }
            Err(None) => return Ok(()),
        };
        if !self.filter.turn_in_time(
            messages
                .iter()
                .map(|message| message.message.created_at.as_str()),
        ) {
            return Ok(());
        }
        let scalars = messages
            .iter()
            .flat_map(decode_message_scalars)
            .collect::<Vec<_>>();
        if scalars.is_empty() {
            self.exclude("source_text_missing");
            return Ok(());
        }
        let episode_id = candidate::turn_episode_id(&outcome.turn_id)?;
        if !outcome.generation.is_finite() {
            return Err(invalid_generation());
        }
        self.entries.push(entry(
            &episode_id,
            &scalars,
            &RevisionTail::Generation(outcome.generation),
        )?);
        Ok(())
    }
}

pub(in crate::cognition) fn invalid_generation() -> CognitionError {
    CognitionError::new(CognitionCode::MemorySourceUnavailable, "invalid_generation")
}

fn entry(
    episode_id: &str,
    scalars: &[butler_turn::conversation::ConversationScalar<'_>],
    tail: &RevisionTail,
) -> CognitionResult<CanonicalInventoryEntry> {
    let revision = episode_revision(scalars, tail).map_err(unavailable)?;
    let mut source_ids = Vec::new();
    let mut hashes = HashSet::new();
    let mut origins = HashSet::new();
    for scalar in scalars {
        hashes.insert(scalar.hash.clone());
        origins.insert(origin(scalar.message.message.origin_kind));
        for span in split_historical_source_spans(scalar.text, MEMORY_SOURCE_WINDOW_BYTES) {
            source_ids.push(hash(&(
                "memory-source",
                episode_id,
                &revision,
                "conversation",
                &scalar.message.message.id,
                &scalar.part.id,
                &scalar.pointer,
                span.start,
                span.end,
                &scalar.hash,
            ))?);
        }
    }
    source_ids.sort();
    let mut source_hashes = hashes.into_iter().collect::<Vec<_>>();
    source_hashes.sort();
    let mut origin_kinds = origins.into_iter().map(str::to_owned).collect::<Vec<_>>();
    origin_kinds.sort();
    Ok(CanonicalInventoryEntry {
        episode_id: episode_id.into(),
        revision,
        source_unit_count: source_ids.len(),
        source_ids,
        source_hashes,
        origin_kinds,
    })
}

fn origin(value: ConversationOriginKind) -> &'static str {
    match value {
        ConversationOriginKind::UserInput => "user_input",
        ConversationOriginKind::AssistantPublic => "assistant_public",
        ConversationOriginKind::InternalControl => "internal_control",
        ConversationOriginKind::Connector => "connector",
        ConversationOriginKind::Unknown => "unknown",
    }
}
fn hash(parts: &(impl serde::Serialize + ?Sized)) -> CognitionResult<String> {
    projection_hash(parts).map_err(unavailable)
}
fn unavailable(error: impl std::error::Error + Send + Sync + 'static) -> CognitionError {
    CognitionError::new(CognitionCode::MemorySourceUnavailable, error.to_string())
        .with_source(error)
}
