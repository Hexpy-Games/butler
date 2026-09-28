//! The meaning stage prompt: numbered passages plus as much earlier context
//! (newest first) as fits the 4 KiB prompt budget.

use serde::Serialize;

use super::{Passage, error, json_error};
use crate::cognition::extraction::ExtractInput;
use crate::cognition::{CognitionCode, CognitionResult};

/// Prompt and context budget of one meaning call, in `JSON.stringify` bytes.
const PROMPT_BUDGET_BYTES: usize = 4096;

/// The meaning stage input shown to the model.
#[derive(Serialize)]
pub(in crate::cognition) struct MeaningPrompt<'a> {
    speaker: &'a str,
    observed_at: &'a str,
    parts: Vec<PromptPart<'a>>,
    context: Vec<PromptContext<'a>>,
}

/// A numbered passage; `before`/`after` are set together for an excerpt.
#[derive(Serialize)]
struct PromptPart<'a> {
    id: usize,
    text: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    before: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    after: Option<&'a str>,
}

/// Earlier context the model may read but not quote.
#[derive(Clone, Copy, Serialize)]
struct PromptContext<'a> {
    text: &'a str,
    basis: &'a str,
}

/// Parts and budget-fitting context of the meaning call. All source units
/// must share one speaker role.
pub(in crate::cognition) fn meaning_prompt<'a>(
    input: &'a ExtractInput,
    passages: &'a [Passage],
) -> CognitionResult<MeaningPrompt<'a>> {
    let Some(first) = input.source_units.first() else {
        return Err(error(CognitionCode::MemoryExtractInvalidInput));
    };
    if input
        .source_units
        .iter()
        .any(|unit| unit.role != first.role)
    {
        return Err(error(CognitionCode::MemoryExtractMixedSourceRoles));
    }
    let parts = passages.iter().map(part).collect::<Vec<_>>();
    if bytes(&parts)? > PROMPT_BUDGET_BYTES {
        return Err(error(CognitionCode::MemoryExtractSourceWindowExceedsBudget));
    }
    let context = fitting_context(input, &parts)?;
    Ok(MeaningPrompt {
        speaker: &first.role,
        observed_at: &first.observed_at,
        parts,
        context,
    })
}

fn part(passage: &Passage) -> PromptPart<'_> {
    let (before, after) = match (&passage.before, &passage.after) {
        (Some(before), Some(after)) => (Some(before.as_str()), Some(after.as_str())),
        _ => (None, None),
    };
    PromptPart {
        id: passage.id,
        text: &passage.text,
        before,
        after,
    }
}

/// Context units without a source span, newest first, each kept only when
/// the prompt with it still fits the budget; kept units stay in source order.
fn fitting_context<'a>(
    input: &'a ExtractInput,
    parts: &[PromptPart<'_>],
) -> CognitionResult<Vec<PromptContext<'a>>> {
    #[derive(Serialize)]
    struct Candidate<'s, 'p, 'c> {
        parts: &'s [PromptPart<'p>],
        context: &'s [PromptContext<'c>],
    }
    let mut context = Vec::new();
    for unit in input
        .context_units
        .iter()
        .rev()
        .filter(|unit| unit.source_span.is_none())
    {
        let item = PromptContext {
            text: &unit.text,
            basis: &unit.basis,
        };
        let mut candidate = context.clone();
        candidate.insert(0, item);
        let candidate = Candidate {
            parts,
            context: &candidate,
        };
        if bytes(&candidate)? <= PROMPT_BUDGET_BYTES {
            context.insert(0, item);
        }
    }
    Ok(context)
}

fn bytes(value: &impl Serialize) -> CognitionResult<usize> {
    Ok(crate::js_json::stringify(value).map_err(json_error)?.len())
}
