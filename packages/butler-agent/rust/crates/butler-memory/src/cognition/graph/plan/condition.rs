//! Requirement bounds checked before a constraint claim is planned: a
//! non-empty action and a condition tree of depth <= 4 with at most 16 atoms
//! whose subjects are planned refs.

use indexmap::IndexMap;

use crate::cognition::CognitionCode;
use crate::cognition::extraction::{ClaimCondition, ClaimRequirement};
use crate::cognition::{CognitionError, CognitionResult};

pub(super) fn validate(
    requirement: &ClaimRequirement,
    refs: &IndexMap<String, String>,
) -> CognitionResult<()> {
    if requirement.action.trim().is_empty() {
        return Err(invalid());
    }
    let mut atoms = 0;
    visit(&requirement.condition, refs, 0, &mut atoms)
}

fn visit(
    condition: &ClaimCondition,
    refs: &IndexMap<String, String>,
    depth: usize,
    atoms: &mut usize,
) -> CognitionResult<()> {
    if depth > 4 {
        return Err(invalid());
    }
    match condition {
        ClaimCondition::Atom { subject, state } => {
            if state.trim().is_empty() {
                return Err(invalid());
            }
            if subject
                .as_ref()
                .is_some_and(|reference| !refs.contains_key(reference))
            {
                return Err(CognitionError::new(
                    CognitionCode::MemoryExtractInvalidRef,
                    "memory_extract_invalid_ref",
                ));
            }
            *atoms += 1;
            if *atoms > 16 {
                return Err(invalid());
            }
        }
        ClaimCondition::Not { not } => visit(not, refs, depth + 1, atoms)?,
        ClaimCondition::All { all: children } | ClaimCondition::Any { any: children } => {
            if children.is_empty() || children.len() > 16 {
                return Err(invalid());
            }
            for child in children {
                visit(child, refs, depth + 1, atoms)?;
            }
        }
    }
    Ok(())
}

fn invalid() -> CognitionError {
    CognitionError::new(
        CognitionCode::MemoryExtractInvalidCondition,
        "memory_extract_invalid_condition",
    )
}
