//! Whether one recall's canonical inventory has an entry without a complete
//! projection. The graph's inventory mirror answers from its uncovered rows
//! plus the source changes after its watermark; without a usable mirror the
//! whole store is scanned.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use butler_turn::conversation::{ConversationSession, ConversationSourceReader, SourceChangeKind};
use indexmap::IndexSet;

use super::{
    CandidateKind, InventoryCandidate, RecallFilter, invalid_generation, read_canonical_inventory,
    recovered_candidate, source_key, turn_candidate, unavailable,
};
use crate::cognition::CognitionResult;
use crate::cognition::graph::{GraphRecallReader, InventoryPhase};
use crate::cognition::recall::RecallRequest;

/// The canonical inventory's part of a recall's projection coverage.
#[derive(Debug)]
pub(in crate::cognition) struct InventoryCoverage {
    /// An admitted entry lacks a complete projection of its revision.
    pub missing: bool,
    /// The deadline cut the inventory short.
    pub partial: bool,
    /// A canonical store was readable.
    pub available: bool,
}

/// The read inputs of one recall's inventory coverage.
#[derive(Clone, Copy)]
pub(in crate::cognition) struct CoverageRead<'a> {
    pub graph: &'a GraphRecallReader,
    pub canonical: Option<&'a ConversationSourceReader>,
    pub input: &'a RecallRequest,
    pub deadline_at: i64,
    pub parse_date: &'a dyn Fn(&str) -> f64,
    pub compare_locale: &'a dyn Fn(&str, &str) -> Ordering,
    pub now_millis: &'a dyn Fn() -> i64,
}

pub(in crate::cognition) fn inventory_coverage(
    read: CoverageRead<'_>,
) -> CognitionResult<InventoryCoverage> {
    if let Some(reader) = read.canonical
        && let Some(coverage) = incremental(&read, reader)?
    {
        return Ok(coverage);
    }
    let inventory = read_canonical_inventory(
        read.canonical,
        read.input,
        read.deadline_at,
        read.parse_date,
        read.compare_locale,
        read.now_millis,
    )?;
    let mut missing = false;
    for entry in &inventory.entries {
        if !read
            .graph
            .episode_complete(&entry.episode_id, &entry.revision)?
        {
            missing = true;
            break;
        }
    }
    Ok(InventoryCoverage {
        missing,
        partial: inventory.partial,
        available: inventory.available,
    })
}

/// Coverage from the mirror; `None` while it is not built for this store at
/// a sequence the store has reached.
fn incremental(
    read: &CoverageRead<'_>,
    reader: &ConversationSourceReader,
) -> CognitionResult<Option<InventoryCoverage>> {
    let Some(state) = read.graph.canonical_inventory_state()? else {
        return Ok(None);
    };
    let (Some(identity), Some(head)) = (
        reader.source_identity().map_err(unavailable)?,
        reader.source_change_head().map_err(unavailable)?,
    ) else {
        return Ok(None);
    };
    if state.phase != InventoryPhase::Ready || identity != state.identity || head < state.seq {
        return Ok(None);
    }
    let mut pass = Pass {
        read,
        reader,
        filter: RecallFilter {
            input: read.input,
            parse_date: read.parse_date,
        },
        sessions: HashMap::new(),
        missing: false,
        partial: false,
    };
    let changed = pass.changes(state.seq, head)?;
    if !pass.partial {
        pass.fresh(&changed)?;
    }
    if !pass.partial {
        pass.stored(&changed.overridden)?;
    }
    Ok(Some(InventoryCoverage {
        missing: pass.missing,
        partial: pass.partial,
        available: true,
    }))
}

/// The sources changed after the watermark: their mirror rows are stale.
#[derive(Default)]
struct Changed {
    turns: IndexSet<String>,
    messages: IndexSet<String>,
    overridden: HashSet<String>,
}

struct Pass<'a> {
    read: &'a CoverageRead<'a>,
    reader: &'a ConversationSourceReader,
    filter: RecallFilter<'a>,
    sessions: HashMap<String, Option<ConversationSession>>,
    missing: bool,
    partial: bool,
}

impl Pass<'_> {
    fn deadline(&mut self) -> bool {
        if (self.read.now_millis)() >= self.read.deadline_at {
            self.partial = true;
        }
        self.partial
    }

    fn changes(&mut self, mut after: u64, head: u64) -> CognitionResult<Changed> {
        let mut changed = Changed::default();
        while after < head && !self.deadline() {
            let page = self
                .reader
                .read_source_changes(after, 500)
                .map_err(unavailable)?;
            let Some(last) = page.last() else { break };
            after = last.seq;
            for change in page {
                match change.kind {
                    SourceChangeKind::Turn => changed.turns.insert(change.entity_id),
                    SourceChangeKind::Message => changed.messages.insert(change.entity_id),
                };
            }
        }
        // A message change also changes every turn whose outcome names it.
        for message in &changed.messages {
            for turn in self.read.graph.canonical_inventory_referencing(message)? {
                changed.turns.insert(turn);
            }
        }
        for turn in &changed.turns {
            changed
                .overridden
                .insert(source_key(CandidateKind::Turn, turn));
        }
        for message in &changed.messages {
            changed
                .overridden
                .insert(source_key(CandidateKind::Message, message));
        }
        Ok(changed)
    }

    /// Reads each changed source as the store holds it now.
    fn fresh(&mut self, changed: &Changed) -> CognitionResult<()> {
        for turn in &changed.turns {
            if self.deadline() {
                return Ok(());
            }
            let Some(outcome) = self.reader.read_recall_outcome(turn).map_err(unavailable)? else {
                continue;
            };
            if !self.session_admitted(&outcome.session_id)? {
                continue;
            }
            let candidate = turn_candidate(self.reader, &outcome)?;
            self.uncovered_entry(&candidate, true)?;
        }
        for message in &changed.messages {
            if self.deadline() {
                return Ok(());
            }
            let Some(message) = self
                .reader
                .read_recovered_source(message)
                .map_err(unavailable)?
            else {
                continue;
            };
            if !self.session_admitted(&message.message.session_id)? {
                continue;
            }
            let candidate = recovered_candidate(&message)?;
            self.uncovered_entry(&candidate, true)?;
        }
        Ok(())
    }

    /// The mirror's uncovered rows of unchanged sources.
    fn stored(&mut self, overridden: &HashSet<String>) -> CognitionResult<()> {
        for candidate in self.read.graph.uncovered_canonical_sources()? {
            if self.deadline() {
                return Ok(());
            }
            if overridden.contains(&candidate.key())
                || !self.session_admitted(&candidate.session_id)?
            {
                continue;
            }
            self.uncovered_entry(&candidate, false)?;
        }
        Ok(())
    }

    /// Records a missing projection when the recall's time admits the
    /// candidate. `probe` checks the graph; a stored uncovered row is
    /// missing by definition.
    fn uncovered_entry(
        &mut self,
        candidate: &InventoryCandidate,
        probe: bool,
    ) -> CognitionResult<()> {
        let Some(eligible) = &candidate.eligible else {
            return Ok(());
        };
        let admitted = match candidate.kind {
            CandidateKind::Turn => self
                .filter
                .turn_in_time(eligible.created_at.iter().map(String::as_str)),
            CandidateKind::Message => eligible.created_at.first().is_some_and(|created| {
                !self.filter.after_cutoff(created) && self.filter.time_contains(created)
            }),
        };
        if !admitted {
            return Ok(());
        }
        let Some(revision) = &eligible.revision else {
            return Err(invalid_generation());
        };
        if !probe
            || !self
                .read
                .graph
                .episode_complete(&eligible.episode_id, revision)?
        {
            self.missing = true;
        }
        Ok(())
    }

    fn session_admitted(&mut self, session_id: &str) -> CognitionResult<bool> {
        if !self.sessions.contains_key(session_id) {
            let session = self.reader.read_session(session_id).map_err(unavailable)?;
            self.sessions.insert(session_id.to_owned(), session);
        }
        Ok(self
            .filter
            .session_admitted(self.sessions.get(session_id).and_then(Option::as_ref)))
    }
}
