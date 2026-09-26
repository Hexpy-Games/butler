//! Canonical Conversation inventory in source scan order, with bounded page storage.

use std::{cmp::Ordering, collections::HashSet};

use indexmap::IndexMap;
use serde_json::{Number, Value};

use crate::cognition::recall::{RecallProjectFilter, RecallRequest, RecallScope, RecallTimeBasis};
use crate::cognition::{
    CognitionError, CognitionResult, MEMORY_SOURCE_WINDOW_BYTES, split_historical_source_spans,
};
use crate::conversation::{
    ConversationOriginKind, ConversationRole, ConversationSourceReader, ConversationStatus,
    decode_message_scalars,
};

use super::identity::{projection_hash, recovered_parts_hash};

#[derive(Clone, Debug)]
pub(in crate::cognition) struct CanonicalInventoryEntry {
    pub episode_id: String,
    pub revision: String,
    pub source_unit_count: usize,
    pub source_ids: Vec<String>,
    pub source_hashes: Vec<String>,
    pub origin_kinds: Vec<String>,
}

#[derive(Debug)]
pub(in crate::cognition) struct CanonicalInventory {
    pub entries: Vec<CanonicalInventoryEntry>,
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
        input,
        deadline_at,
        parse_date,
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
    input: &'a RecallRequest,
    deadline_at: i64,
    parse_date: &'a dyn Fn(&str) -> f64,
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
    fn in_scope(&self, session: &str, project: Option<&str>) -> bool {
        if self.input.scope == RecallScope::CurrentSession
            && session != self.input.runtime.session_id
        {
            return false;
        }
        if self.input.scope == RecallScope::CurrentProject
            && project != self.input.runtime.project_id.as_deref()
        {
            return false;
        }
        if !self.input.session_ids.is_empty()
            && !self.input.session_ids.iter().any(|id| id == session)
        {
            return false;
        }
        if self.input.project_filter == RecallProjectFilter::Unassigned && project.is_some() {
            return false;
        }
        if self.input.project_filter == RecallProjectFilter::Selected
            && !project.is_some_and(|id| self.input.project_ids.iter().any(|project| project == id))
        {
            return false;
        }
        true
    }
    fn time_contains(&self, created: &str) -> bool {
        let Some(time) = self
            .input
            .time
            .as_ref()
            .filter(|time| time.basis == RecallTimeBasis::Conversation)
        else {
            return true;
        };
        let value = (self.parse_date)(created);
        value >= (self.parse_date)(&time.from) && value < (self.parse_date)(&time.to)
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
            if session.as_ref().is_none_or(|session| {
                session.status == "deleted"
                    || !self.in_scope(&session.id, session.project_id.as_deref())
            }) || (self.parse_date)(&message.message.created_at)
                > (self.parse_date)(&self.input.as_of)
            {
                self.exclude("scope_or_time");
                continue;
            }
            if !self.time_contains(&message.message.created_at) {
                continue;
            }
            let scalars = decode_message_scalars(&message);
            if scalars.is_empty() {
                self.exclude("source_text_missing");
                continue;
            }
            let source_hash = recovered_parts_hash(&message).map_err(unavailable)?;
            let episode_id = hash(vec![
                "canonical-conversation-message".into(),
                message.message.id.clone().into(),
            ])?;
            self.entries
                .push(entry(&episode_id, &scalars, Value::String(source_hash))?);
        }
        Ok(len)
    }
    fn outcome(&mut self, outcome: &crate::conversation::RecallOutcomeRow) -> CognitionResult<()> {
        let session = self
            .reader
            .read_session(&outcome.session_id)
            .map_err(unavailable)?;
        if session.as_ref().is_none_or(|session| {
            session.status == "deleted"
                || !self.in_scope(&session.id, session.project_id.as_deref())
        }) {
            self.exclude("scope_or_session");
            return Ok(());
        }
        let turn = self
            .reader
            .read_turn(&outcome.turn_id)
            .map_err(unavailable)?;
        if turn.as_ref().is_none_or(|turn| {
            turn.id != outcome.turn_id
                || turn.session_id != outcome.session_id
                || !matches!(turn.status.as_str(), "complete" | "failed" | "aborted")
        }) {
            self.exclude("turn_not_terminal");
            return Ok(());
        }
        let request = outcome
            .request_message_id
            .as_deref()
            .map(|id| self.reader.read_message(id))
            .transpose()
            .map_err(unavailable)?
            .flatten();
        let assistant = outcome
            .public_assistant_message_id
            .as_deref()
            .map(|id| self.reader.read_message(id))
            .transpose()
            .map_err(unavailable)?
            .flatten();
        if request.as_ref().is_none_or(|message| {
            message.message.role != ConversationRole::User
                || !matches!(
                    message.message.status,
                    ConversationStatus::Complete | ConversationStatus::Compacted
                )
                || message.message.origin_kind != ConversationOriginKind::UserInput
        }) {
            self.exclude(
                if request.as_ref().is_some_and(|message| {
                    message.message.origin_kind == ConversationOriginKind::Unknown
                }) {
                    "unknown_origin"
                } else {
                    "request_ineligible"
                },
            );
            return Ok(());
        }
        if outcome.public_assistant_message_id.is_some()
            && assistant.as_ref().is_none_or(|message| {
                message.message.role != ConversationRole::Assistant
                    || message.message.status != ConversationStatus::Complete
                    || message.message.origin_kind != ConversationOriginKind::AssistantPublic
            })
        {
            self.exclude(
                if assistant.as_ref().is_some_and(|message| {
                    message.message.origin_kind == ConversationOriginKind::Unknown
                }) {
                    "unknown_origin"
                } else {
                    "assistant_ineligible"
                },
            );
            return Ok(());
        }
        let Some(request) = request else {
            return Ok(());
        };
        let mut messages = vec![request];
        if let Some(assistant) = assistant {
            messages.push(assistant);
        }
        let observed = messages
            .iter()
            .filter(|message| {
                (self.parse_date)(&message.message.created_at)
                    <= (self.parse_date)(&self.input.as_of)
            })
            .collect::<Vec<_>>();
        if observed.is_empty() {
            return Ok(());
        }
        if self
            .input
            .time
            .as_ref()
            .is_some_and(|time| time.basis == RecallTimeBasis::Conversation)
            && !observed
                .iter()
                .any(|message| self.time_contains(&message.message.created_at))
        {
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
        let episode_id = hash(vec![
            "canonical-conversation-turn".into(),
            outcome.turn_id.clone().into(),
        ])?;
        let generation = Number::from_f64(outcome.generation).ok_or_else(|| {
            CognitionError::new("memory_source_unavailable", "invalid_generation")
        })?;
        self.entries
            .push(entry(&episode_id, &scalars, Value::Number(generation))?);
        Ok(())
    }
}

fn entry(
    episode_id: &str,
    scalars: &[crate::conversation::ConversationScalar<'_>],
    tail: Value,
) -> CognitionResult<CanonicalInventoryEntry> {
    let mut parts = vec![Value::String("episode-revision".into())];
    for scalar in scalars {
        parts.extend([
            scalar.message.message.id.clone().into(),
            scalar.part.id.clone().into(),
            scalar.pointer.clone().into(),
            scalar.hash.clone().into(),
        ]);
    }
    parts.push(tail);
    let revision = hash(parts)?;
    let mut source_ids = Vec::new();
    let mut hashes = HashSet::new();
    let mut origins = HashSet::new();
    for scalar in scalars {
        hashes.insert(scalar.hash.clone());
        origins.insert(origin(scalar.message.message.origin_kind));
        for span in split_historical_source_spans(scalar.text, MEMORY_SOURCE_WINDOW_BYTES) {
            source_ids.push(hash(vec![
                "memory-source".into(),
                episode_id.into(),
                revision.clone().into(),
                "conversation".into(),
                scalar.message.message.id.clone().into(),
                scalar.part.id.clone().into(),
                scalar.pointer.clone().into(),
                span.start.into(),
                span.end.into(),
                scalar.hash.clone().into(),
            ])?);
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
        ConversationOriginKind::Unknown => "unknown",
    }
}
fn hash(values: Vec<Value>) -> CognitionResult<String> {
    projection_hash(values).map_err(unavailable)
}
fn unavailable(error: impl std::fmt::Display) -> CognitionError {
    CognitionError::new("memory_source_unavailable", error.to_string())
}
