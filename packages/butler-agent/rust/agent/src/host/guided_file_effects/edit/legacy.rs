//! Bounded reconstruction of a pre-hint single edit's durable input identity.

use std::sync::Arc;

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::btcc::{BtccError, EffectAdapter, effect_input_sha256};

use super::{Edit, State, rejected, sha};

const MAX_CANDIDATES: usize = 16;
const MAX_WORK_UNITS: usize = 1_000_000;

#[derive(Default)]
struct Budget {
    candidates: usize,
    work: usize,
}

impl Budget {
    fn spend(&mut self, units: usize) -> Option<()> {
        self.work = self.work.checked_add(units.max(1))?;
        (self.work <= MAX_WORK_UNITS).then_some(())
    }

    fn candidate(&mut self) -> Option<()> {
        self.candidates += 1;
        (self.candidates <= MAX_CANDIDATES).then_some(())
    }
}

fn locations(text: &str, needle: &str, budget: &mut Budget) -> Option<Vec<(usize, usize)>> {
    budget.spend(text.encode_utf16().count())?;
    let mut found = Vec::new();
    let mut from = 0;
    let mut scanned = 0;
    let mut line = 1;
    while from + needle.len() <= text.len() {
        let Some(relative) = text[from..].find(needle) else {
            break;
        };
        let offset = from + relative;
        if found.len() == MAX_CANDIDATES {
            return None;
        }
        line += text[scanned..offset]
            .bytes()
            .filter(|byte| *byte == b'\n')
            .count();
        scanned = offset;
        found.push((offset, line));
        from = offset + text[offset..].chars().next()?.len_utf8();
    }
    Some(found)
}

fn replacement_hash(text: &str, offset: usize, length: usize, replacement: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(&text.as_bytes()[..offset]);
    hash.update(replacement.as_bytes());
    hash.update(&text.as_bytes()[offset + length..]);
    format!("{:x}", hash.finalize())
}

fn candidate(
    edit: &Edit,
    line: usize,
    before: &str,
    after: &str,
    adapter: &Arc<dyn EffectAdapter>,
) -> Option<Value> {
    adapter
        .normalize_input(&json!({"path":edit.path,"start_line":line,
            "old_text":edit.old_text,"new_text":edit.new_text,
            "before_sha256":before,"after_sha256":after}))
        .ok()
}

pub(super) fn recover(
    edit: &Edit,
    state: &State,
    prior_input_sha256: &str,
    adapter: &Arc<dyn EffectAdapter>,
) -> Result<Value, BtccError> {
    let mismatch = || {
        rejected(
            "edit_file_reconciliation_mismatch",
            "The file no longer matches the durable edit intent.",
        )
    };
    let mut budget = Budget::default();
    let mut match_found = None;
    let mut matches = 0;
    let before_locations =
        locations(&state.text, &edit.old_text, &mut budget).ok_or_else(mismatch)?;
    for (offset, line) in before_locations {
        if edit.old_text == edit.new_text {
            continue;
        }
        budget.candidate().ok_or_else(mismatch)?;
        budget
            .spend(state.text.encode_utf16().count())
            .ok_or_else(mismatch)?;
        let after = replacement_hash(&state.text, offset, edit.old_text.len(), &edit.new_text);
        if let Some(value) = candidate(edit, line, &state.before, &after, adapter)
            && edit
                .expected
                .as_deref()
                .is_none_or(|expected| expected == state.before)
            && effect_input_sha256(&value).map_err(|_| mismatch())? == prior_input_sha256
        {
            matches += 1;
            match_found = Some(value);
        }
    }
    if !edit.new_text.is_empty() {
        budget
            .spend(state.text.encode_utf16().count())
            .ok_or_else(mismatch)?;
        let after_hash = sha(&state.text);
        if after_hash == state.before {
            let after_locations =
                locations(&state.text, &edit.new_text, &mut budget).ok_or_else(mismatch)?;
            for (offset, _) in after_locations {
                let before_len = state.text.encode_utf16().count()
                    - edit.new_text.encode_utf16().count()
                    + edit.old_text.encode_utf16().count();
                budget.spend(before_len).ok_or_else(mismatch)?;
                let mut before_text = String::with_capacity(
                    state.text.len() - edit.new_text.len() + edit.old_text.len(),
                );
                before_text.push_str(&state.text[..offset]);
                before_text.push_str(&edit.old_text);
                before_text.push_str(&state.text[offset + edit.new_text.len()..]);
                if before_text == state.text {
                    continue;
                }
                let before_locations =
                    locations(&before_text, &edit.old_text, &mut budget).ok_or_else(mismatch)?;
                budget
                    .spend(before_text.encode_utf16().count())
                    .ok_or_else(mismatch)?;
                let before_hash = sha(&before_text);
                for (_, line) in before_locations {
                    budget.candidate().ok_or_else(mismatch)?;
                    if let Some(value) = candidate(edit, line, &before_hash, &after_hash, adapter)
                        && edit
                            .expected
                            .as_deref()
                            .is_none_or(|expected| expected == before_hash)
                        && effect_input_sha256(&value).map_err(|_| mismatch())?
                            == prior_input_sha256
                    {
                        matches += 1;
                        match_found = Some(value);
                    }
                }
            }
        }
    }
    if matches == 1 {
        match_found.ok_or_else(mismatch)
    } else {
        Err(mismatch())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::btcc::{EffectFuture, RegisteredEditPort, WorkspaceFileEditEffectAdapter};
    use crate::workspace::EffectFileScope;

    struct UnusedRegisteredEdit;
    impl RegisteredEditPort for UnusedRegisteredEdit {
        fn edit<'a>(&'a self, _: Value) -> EffectFuture<'a, Value> {
            Box::pin(async { unreachable!("recovery never dispatches") })
        }
    }

    #[test]
    fn reconstructs_same_durable_identity_before_and_after_a_single_edit() {
        let root =
            std::env::temp_dir().join(format!("butler-legacy-edit-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let scope = EffectFileScope {
            workspace: root.clone(),
            butler_data: root.join("data"),
            protected_roots: vec![],
            installation_root: None,
        };
        let adapter: Arc<dyn EffectAdapter> = Arc::new(WorkspaceFileEditEffectAdapter::new(
            scope,
            Arc::new(UnusedRegisteredEdit),
        ));
        let edit = Edit {
            path: "doc.txt".into(),
            hint: None,
            old_text: "beta".into(),
            new_text: "gamma".into(),
            expected: None,
        };
        let before = "alpha beta";
        let after = "alpha gamma";
        let prepared = candidate(&edit, 1, &sha(before), &sha(after), &adapter).unwrap();
        let identity = effect_input_sha256(&prepared).unwrap();
        for text in [before, after] {
            let state = State {
                before: sha(text),
                text: text.into(),
                original: text.into(),
            };
            assert_eq!(
                recover(&edit, &state, &identity, &adapter).unwrap(),
                prepared
            );
        }
        let state = State { before: sha("beta beta beta beta beta beta beta beta beta beta beta beta beta beta beta beta beta"),
            text: "beta beta beta beta beta beta beta beta beta beta beta beta beta beta beta beta beta".into(),
            original: String::new() };
        assert_eq!(
            recover(&edit, &state, &identity, &adapter)
                .unwrap_err()
                .code,
            "edit_file_reconciliation_mismatch"
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
