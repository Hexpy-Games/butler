//! Scoped semantic lanes; ranking and seed fusion live in the pure recall owner.

mod aliases;
mod context;
mod lexical;
#[cfg(test)]
pub(super) mod tests;
mod vectors;

use rusqlite::Connection;

use crate::cognition::CognitionResult;
use crate::cognition::recall::{
    RecallRequest, RecallVectorMatch, SemanticSelection, select_semantic_seeds,
};

fn json_error(error: serde_json::Error) -> crate::cognition::CognitionError {
    crate::cognition::CognitionError::new("memory_graph_failed", error.to_string())
}

pub(super) fn select(
    db: &Connection,
    input: &RecallRequest,
    recent_message_ids: &[String],
    vector_nodes: &[RecallVectorMatch],
    deadline_at: i64,
    mut now_millis: impl FnMut() -> i64,
) -> CognitionResult<SemanticSelection> {
    let admitted = input.admitted_channels.clone().unwrap_or_default();
    let mut channels = Vec::new();
    if admitted.graph || admitted.lexical || admitted.explicit {
        channels.extend(aliases::select(db, input)?);
    }
    let mut lexical_partial = false;
    if admitted.lexical || admitted.explicit {
        let (selected, partial) = lexical::select(db, input, deadline_at, &mut now_millis)?;
        channels.extend(selected);
        lexical_partial = partial;
    }
    if admitted.vector {
        channels.extend(vectors::select(db, input, vector_nodes)?);
    }
    if admitted.context {
        let selected = context::select(db, input, recent_message_ids)?;
        channels.extend(selected);
    }
    Ok(select_semantic_seeds(
        channels,
        lexical_partial,
        16,
        input.time.is_some(),
        admitted.graph || admitted.lexical || admitted.vector || admitted.explicit,
    ))
}
