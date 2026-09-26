use std::fs::File;
use std::io::Read;
use std::path::Path;

use crate::locale::LocaleCollation;
use crate::project_ledger::commands;
use crate::project_ledger::publication::ProjectLedgerRecordUpdate;

use super::contracts::LedgerEffectError;

const MAX_EVENT_LINE_BYTES: usize = 4 * 1024 * 1024;

pub(super) fn apply(
    root: &Path,
    updates: &[ProjectLedgerRecordUpdate],
    collation: &LocaleCollation,
) -> Result<(), LedgerEffectError> {
    for update in updates {
        commands::apply_candidate_effect_update(root, update, collation)
            .map_err(|()| LedgerEffectError::Uncertain)?;
    }
    for view in ["dashboard", "handoff", "roadmap"] {
        commands::render_candidate(root, view, collation)
            .map_err(|()| LedgerEffectError::Uncertain)?;
    }
    commands::write_candidate_index(root, collation).map_err(|()| LedgerEffectError::Uncertain)
}

pub(super) fn inspect(root: &Path, collation: &LocaleCollation) -> Result<(), LedgerEffectError> {
    validate_events(&root.join("ledger.jsonl"))?;
    if !commands::candidate_index_available(root).map_err(|()| LedgerEffectError::Uncertain)? {
        return Err(LedgerEffectError::Uncertain);
    }
    if commands::candidate_check_errors(root, collation)
        .map_err(|()| LedgerEffectError::Uncertain)?
    {
        return Err(LedgerEffectError::Uncertain);
    }
    Ok(())
}

fn validate_events(path: &Path) -> Result<(), LedgerEffectError> {
    let mut file = File::open(path).map_err(|_| LedgerEffectError::Uncertain)?;
    let mut buffer = vec![0u8; 64 * 1024];
    let mut line = Vec::new();
    loop {
        let size = file
            .read(&mut buffer)
            .map_err(|_| LedgerEffectError::Uncertain)?;
        if size == 0 {
            break;
        }
        let mut start = 0;
        while start < size {
            let end = buffer[start..size]
                .iter()
                .position(|byte| *byte == b'\n')
                .map(|at| start + at);
            let part = &buffer[start..end.unwrap_or(size)];
            if part.len() > MAX_EVENT_LINE_BYTES.saturating_sub(line.len()) {
                return Err(LedgerEffectError::Uncertain);
            }
            line.extend_from_slice(part);
            if let Some(end) = end {
                validate_line(&line)?;
                line.clear();
                start = end + 1;
            } else {
                break;
            }
        }
    }
    if !line.is_empty() {
        validate_line(&line)?;
    }
    Ok(())
}

fn validate_line(line: &[u8]) -> Result<(), LedgerEffectError> {
    let text = String::from_utf8_lossy(line);
    if !crate::public_text::trim_js_whitespace(&text).is_empty() {
        crate::json::JsonDocument::from_encoded(text.into_owned())
            .map_err(|_| LedgerEffectError::Uncertain)?;
    }
    Ok(())
}
