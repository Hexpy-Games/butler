use rusqlite::{Connection, OptionalExtension, params};

use super::source_changed;
use crate::cognition::{
    CognitionResult,
    extraction::ExtractInput,
    graph::{db_error, plan::ValidatedQuote},
};

pub(in crate::cognition::graph) fn resolve_quotes(
    tx: &Connection,
    input: &ExtractInput,
    quotes: &[ValidatedQuote],
) -> CognitionResult<Vec<ValidatedQuote>> {
    let mut resolved = Vec::new();
    for quote in quotes {
        if let Some(context) = input
            .context_units
            .iter()
            .find(|unit| unit.ref_id == quote.source_id)
            && let Some(span) = &context.source_span
        {
            let start = crate::json::saturating_usize(span.byte_start) + quote.byte_start;
            let end = crate::json::saturating_usize(span.byte_start) + quote.byte_end;
            let anchor=tx.query_row("SELECT episode_id,revision,part_id,scalar_pointer,conversation_message_id FROM memory_chunk_sources WHERE source_id=?1",[&span.source_ref],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,String>(3)?,row.get::<_,Option<String>>(4)?))).optional().map_err(db_error)?.ok_or_else(source_changed)?;
            let mut statement=tx.prepare("SELECT source_id,byte_start,byte_end FROM memory_source_leaves WHERE episode_id=?1 AND revision=?2 AND part_id=?3 AND scalar_pointer=?4 AND conversation_message_id IS ?5 AND byte_end>?6 AND byte_start<?7 ORDER BY byte_start").map_err(db_error)?;
            let rows = statement
                .query_map(
                    params![
                        anchor.0,
                        anchor.1,
                        anchor.2,
                        anchor.3,
                        anchor.4,
                        i64::try_from(start).unwrap_or(i64::MAX),
                        i64::try_from(end).unwrap_or(i64::MAX)
                    ],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            usize::try_from(row.get::<_, i64>(1)?).unwrap_or_default(),
                            usize::try_from(row.get::<_, i64>(2)?).unwrap_or_default(),
                        ))
                    },
                )
                .map_err(db_error)?;
            for row in rows {
                let (source_id, source_start, source_end) = row.map_err(db_error)?;
                let overlap_start = start.max(source_start);
                let overlap_end = end.min(source_end);
                if overlap_start >= overlap_end {
                    continue;
                }
                let local_start = overlap_start - crate::json::saturating_usize(span.byte_start);
                let local_end = overlap_end - crate::json::saturating_usize(span.byte_start);
                let text = context
                    .text
                    .get(local_start..local_end)
                    .ok_or_else(source_changed)?;
                resolved.push(ValidatedQuote {
                    source_id,
                    byte_start: overlap_start - source_start,
                    byte_end: overlap_end - source_start,
                    quote: text.into(),
                });
            }
            continue;
        }
        resolved.push(quote.clone());
    }
    Ok(resolved)
}
