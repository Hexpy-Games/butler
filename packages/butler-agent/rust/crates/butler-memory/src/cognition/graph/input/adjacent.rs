//! Adjacent excerpts: each quoted passage gains surrounding source text as a
//! context unit, as wide as the extraction prompt budget allows.

use std::collections::HashMap;
use std::path::Path;

use crate::cognition::CognitionCode;
use crate::cognition::{
    CognitionError, CognitionResult, CognitionSourceRow,
    extraction::{
        ExtractInput, ProjectionContextUnit, ProjectionSourceSpan, ProjectionSourceUnit,
        meaning_prompt, source_passages,
    },
    grapheme_byte_boundaries, hydrate_conversation_source,
};
use butler_turn::conversation::ConversationMessageWithParts;

/// Replaces the input's excerpts with the widest set (in graphemes around
/// each passage) whose prompt fits the budget.
pub(super) fn attach(
    input: &mut ExtractInput,
    rows: &[CognitionSourceRow],
    messages: &HashMap<String, ConversationMessageWithParts>,
    source_root: &Path,
    expansion: u8,
) -> CognitionResult<()> {
    input
        .context_units
        .retain(|unit| unit.source_span.is_none());
    let passages = source_passages(input)?;
    let sources = Sources {
        rows: rows
            .iter()
            .map(|row| (row.source_id.as_str(), row))
            .collect(),
        messages,
        source_root,
    };
    let original_context = input.context_units.clone();
    let widths: &[usize] = if expansion == 0 {
        &[64, 32, 16, 8, 4, 2, 1, 0]
    } else {
        &[128, 64, 32, 16, 8, 4, 2, 1, 0]
    };
    for &width in widths {
        let mut excerpts = Vec::new();
        for passage in &passages {
            let source_ref = passage.quote.unit_ref.as_str();
            let unit = input
                .source_units
                .iter()
                .find(|unit| unit.ref_id == source_ref)
                .ok_or_else(changed)?;
            let focus = Focus {
                unit,
                text: &passage.text,
                occurrence: passage.quote.occurrence,
            };
            if let Some(excerpt) = sources.excerpt(&focus, width, &input.revision)? {
                excerpts.push(excerpt);
            }
        }
        input.context_units = original_context.iter().cloned().chain(excerpts).collect();
        input.context_expansion = Some(f64::from(expansion));
        match source_passages(input).and_then(|parts| meaning_prompt(input, &parts).map(drop)) {
            Ok(()) => return Ok(()),
            Err(problem)
                if problem.code() == "memory_extract_source_window_exceeds_budget" && width > 0 => {
            }
            Err(problem) => return Err(problem),
        }
    }
    Err(CognitionError::new(
        CognitionCode::MemoryExtractSourceWindowExceedsBudget,
        "memory_extract_source_window_exceeds_budget",
    ))
}

/// A quoted passage inside one source unit.
struct Focus<'a> {
    unit: &'a ProjectionSourceUnit,
    text: &'a str,
    occurrence: usize,
}

/// Source rows and canonical messages of the input.
struct Sources<'a> {
    rows: HashMap<&'a str, &'a CognitionSourceRow>,
    messages: &'a HashMap<String, ConversationMessageWithParts>,
    source_root: &'a Path,
}

impl Sources<'_> {
    /// The full scalar text a row is a slice of.
    fn scalar(&self, row: &CognitionSourceRow) -> CognitionResult<String> {
        if matches!(row.source_kind.as_str(), "task_report" | "explicit_record") {
            let owner = crate::cognition::sources::read_typed_record(
                self.source_root,
                &self.source_root.join("cognition/memory"),
                &row.source_kind,
                &row.part_id,
            )?
            .ok_or_else(changed)?;
            if owner.revision != row.revision || owner.content_hash != row.content_hash {
                return Err(changed());
            }
            return Ok(owner.text);
        }
        let message_id = row.conversation_message_id.as_deref().ok_or_else(changed)?;
        let message = self.messages.get(message_id).ok_or_else(changed)?;
        Ok(hydrate_conversation_source(message, row, f64::INFINITY)?
            .scalar_text
            .to_owned())
    }

    /// The passage widened by `width` graphemes on each side (bounded to 480
    /// graphemes overall), or `None` when that adds nothing.
    fn excerpt(
        &self,
        focus: &Focus<'_>,
        width: usize,
        revision: &str,
    ) -> CognitionResult<Option<ProjectionContextUnit>> {
        let source_ref = focus.unit.ref_id.as_str();
        let row = *self.rows.get(source_ref).ok_or_else(changed)?;
        let scalar = self.scalar(row)?;
        let at = focus
            .unit
            .text
            .match_indices(focus.text)
            .nth(focus.occurrence)
            .map(|(offset, _)| offset)
            .ok_or_else(changed)?;
        let row_start = butler_core::json::saturating_usize(row.byte_start);
        let (focus_start, focus_end) = (at, at + focus.text.len());
        let boundaries = grapheme_byte_boundaries(&scalar);
        let position = |offset: usize| {
            boundaries
                .binary_search(&(row_start + offset))
                .map_err(|_| changed())
        };
        let (first, last) = (position(focus_start)?, position(focus_end)?);
        let allowance = width.min(480usize.saturating_sub(last - first) / 2);
        let boundary = |index: usize| boundaries.get(index).copied().ok_or_else(changed);
        let start = boundary(first.saturating_sub(allowance))?;
        let end = boundary((last + allowance).min(boundaries.len().saturating_sub(1)))?;
        if start == row_start + focus_start && end == row_start + focus_end {
            return Ok(None);
        }
        let span = ProjectionSourceSpan {
            source_ref: source_ref.into(),
            byte_start: start as f64,
            byte_end: end as f64,
            focus_start: focus_start as f64,
            focus_end: focus_end as f64,
            prefix_bytes: (row_start + focus_start - start) as f64,
        };
        let hash = crate::cognition::sources::projection_hash_for_graph(&(
            &source_ref,
            &revision,
            serde_json::to_value(&span).map_err(json_error)?,
        ))?;
        Ok(Some(ProjectionContextUnit {
            ref_id: format!("memory-excerpt:{}", hash.get(..48).unwrap_or(&hash)),
            text: scalar.get(start..end).ok_or_else(changed)?.into(),
            observed_at: row.observed_at.clone(),
            basis: row.basis.clone(),
            source_span: Some(span),
        }))
    }
}

fn changed() -> CognitionError {
    CognitionError::new(CognitionCode::MemorySourceChanged, "memory_source_changed")
}

fn json_error(error: impl std::error::Error + Send + Sync + 'static) -> CognitionError {
    CognitionError::new(CognitionCode::MemoryExtractInvalidJson, error.to_string())
        .with_source(error)
}
