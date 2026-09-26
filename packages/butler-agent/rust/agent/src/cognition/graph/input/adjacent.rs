use std::collections::HashMap;
use std::path::Path;

use serde_json::json;

use crate::cognition::{
    CognitionError, CognitionResult, CognitionSourceRow,
    extraction::{
        ExtractInput, ProjectionContextUnit, ProjectionSourceSpan, meaning_prompt, source_passages,
    },
    grapheme_byte_boundaries, hydrate_conversation_source,
};
use crate::conversation::ConversationMessageWithParts;

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
    let source_rows = rows
        .iter()
        .map(|row| (row.source_id.as_str(), row))
        .collect::<HashMap<_, _>>();
    let source_units = input
        .source_units
        .iter()
        .map(|unit| (unit.ref_id.as_str(), unit))
        .collect::<HashMap<_, _>>();
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
            let row = source_rows.get(source_ref).ok_or_else(changed)?;
            let unit = source_units.get(source_ref).ok_or_else(changed)?;
            let typed_scalar =
                if matches!(row.source_kind.as_str(), "task_report" | "explicit_record") {
                    let owner = crate::cognition::sources::read_typed_record(
                        source_root,
                        &source_root.join("cognition/memory"),
                        &row.source_kind,
                        &row.part_id,
                    )?
                    .ok_or_else(changed)?;
                    if owner.revision != row.revision || owner.content_hash != row.content_hash {
                        return Err(changed());
                    }
                    Some(owner.text)
                } else {
                    None
                };
            let scalar = if let Some(text) = typed_scalar.as_deref() {
                text
            } else {
                let message_id = row.conversation_message_id.as_deref().ok_or_else(changed)?;
                let message = messages.get(message_id).ok_or_else(changed)?;
                hydrate_conversation_source(message, row, f64::INFINITY)?.scalar_text
            };
            let mut matches = unit.text.match_indices(&passage.text);
            let at = matches
                .nth(passage.quote.occurrence)
                .map(|(offset, _)| offset)
                .ok_or_else(changed)?;
            let focus_start = at;
            let focus_end = at + passage.text.len();
            let boundaries = grapheme_byte_boundaries(scalar);
            let first = boundaries
                .binary_search(&(row.byte_start as usize + focus_start))
                .map_err(|_| changed())?;
            let last = boundaries
                .binary_search(&(row.byte_start as usize + focus_end))
                .map_err(|_| changed())?;
            let allowance = width.min(480usize.saturating_sub(last - first) / 2);
            let start = boundaries[first.saturating_sub(allowance)];
            let end = boundaries[(last + allowance).min(boundaries.len() - 1)];
            if start == row.byte_start as usize + focus_start
                && end == row.byte_start as usize + focus_end
            {
                continue;
            }
            let span = ProjectionSourceSpan {
                source_ref: source_ref.into(),
                byte_start: start as f64,
                byte_end: end as f64,
                focus_start: focus_start as f64,
                focus_end: focus_end as f64,
                prefix_bytes: (row.byte_start as usize + focus_start - start) as f64,
            };
            let hash = crate::cognition::sources::projection_hash_for_graph(vec![
                json!(source_ref),
                json!(input.revision),
                serde_json::to_value(&span).map_err(json_error)?,
            ])?;
            excerpts.push(ProjectionContextUnit {
                ref_id: format!("memory-excerpt:{}", &hash[..48]),
                text: scalar[start..end].into(),
                observed_at: row.observed_at.clone(),
                basis: row.basis.clone(),
                source_span: Some(span),
            });
        }
        input.context_units = original_context.iter().cloned().chain(excerpts).collect();
        input.context_expansion = Some(f64::from(expansion));
        match source_passages(input).and_then(|parts| meaning_prompt(input, &parts)) {
            Ok(_) => return Ok(()),
            Err(problem)
                if problem.code == "memory_extract_source_window_exceeds_budget" && width > 0 => {}
            Err(problem) => return Err(problem),
        }
    }
    Err(CognitionError::new(
        "memory_extract_source_window_exceeds_budget",
        "memory_extract_source_window_exceeds_budget",
    ))
}
fn changed() -> CognitionError {
    CognitionError::new("memory_source_changed", "memory_source_changed")
}
fn json_error(error: impl std::fmt::Display) -> CognitionError {
    CognitionError::new("memory_extract_invalid_json", error.to_string())
}
