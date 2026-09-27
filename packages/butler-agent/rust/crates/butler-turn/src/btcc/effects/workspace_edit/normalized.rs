use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::workspace::EffectFileScope;

use super::super::contracts::{
    EffectFailure, EffectResult, PreparedEdit, PreparedEditEntry, RecoveryEntry, RecoveryHint,
};

/// One normalized edit. Field order is the journaled (identity-hashed) form.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub(super) struct EditEntry {
    pub(super) path: String,
    pub(super) start_line: u64,
    pub(super) old_text: String,
    pub(super) new_text: String,
    pub(super) before_sha256: String,
    pub(super) after_sha256: String,
}

/// The normalized input of an edit_file effect: one edit or a batch.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub(super) enum EditInput {
    Batch { edits: Vec<EditEntry> },
    Single(EditEntry),
}

/// Which side of an edit a file state is compared with.
#[derive(Clone, Copy)]
pub(super) enum Side {
    Before,
    After,
}

impl EditEntry {
    pub(super) fn sha(&self, side: Side) -> &str {
        match side {
            Side::Before => &self.before_sha256,
            Side::After => &self.after_sha256,
        }
    }

    fn prepared(&self) -> PreparedEditEntry {
        PreparedEditEntry {
            path: self.path.clone(),
            start_line: self.start_line,
            old_text: self.old_text.clone(),
            new_text: self.new_text.clone(),
            expected_sha256: self.before_sha256.clone(),
        }
    }
}

impl EditInput {
    /// Decodes a journaled normalized input.
    // Passthrough: parse boundary validating untyped JSON into typed values.
    pub(super) fn decode(input: &Value) -> Result<Self, serde_json::Error> {
        Self::deserialize(input)
    }

    pub(super) fn is_batch(&self) -> bool {
        matches!(self, Self::Batch { .. })
    }

    pub(super) fn entries(&self) -> Vec<&EditEntry> {
        match self {
            Self::Batch { edits } => edits.iter().collect(),
            Self::Single(entry) => vec![entry],
        }
    }

    /// The request for the registered edit tool.
    pub(super) fn prepared(&self) -> PreparedEdit {
        match self {
            Self::Batch { edits } => PreparedEdit::Batch {
                edits: edits.iter().map(EditEntry::prepared).collect(),
            },
            Self::Single(entry) => PreparedEdit::Single(entry.prepared()),
        }
    }
}

fn invalid(message: impl Into<String>) -> EffectFailure {
    EffectFailure::policy("effect_request_invalid", message)
}

/// Validates raw edit_file tool arguments (passthrough JSON) into the normalized input.
pub(super) fn input(value: &Value, scope: &EffectFileScope) -> EffectResult<EditInput> {
    let object = value
        .as_object()
        .ok_or_else(|| invalid("edit_file effect input must be an object"))?;
    if let Some(edits) = object.get("edits") {
        if object.len() != 1 {
            return Err(invalid(
                "edit_file effect rejects mixed single and batch input",
            ));
        }
        let edits = edits
            .as_array()
            .filter(|items| (2..=20).contains(&items.len()))
            .ok_or_else(|| invalid("edit_file batch requires 2-20 entries"))?;
        return Ok(EditInput::Batch {
            edits: edits
                .iter()
                .map(|entry| normalize_entry(entry, scope))
                .collect::<EffectResult<Vec<_>>>()?,
        });
    }
    normalize_entry(value, scope).map(EditInput::Single)
}

// Passthrough: parse boundary validating untyped JSON into typed values.
fn normalize_entry(value: &Value, scope: &EffectFileScope) -> EffectResult<EditEntry> {
    let object = value
        .as_object()
        .ok_or_else(|| invalid("edit_file effect entry must be an object"))?;
    if let Some(unknown) = object.keys().find(|key| {
        !matches!(
            key.as_str(),
            "path" | "start_line" | "old_text" | "new_text" | "before_sha256" | "after_sha256"
        )
    }) {
        return Err(invalid(format!(
            "edit_file effect rejects unknown input: {unknown}"
        )));
    }
    let path = object
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("edit_file requires path"))?;
    let path = crate::btcc::effects::workspace_file::normalized_workspace_effect_path(scope, path)?;
    let line = butler_core::json::saturating_u64(
        object
            .get("start_line")
            .and_then(Value::as_f64)
            .filter(|number| {
                number.is_finite()
                    && number.fract() == 0.0
                    && (1.0..=9_007_199_254_740_991.0).contains(number)
            })
            .ok_or_else(|| invalid("edit_file effect start_line must be a positive integer"))?,
    );
    let old_text = object
        .get("old_text")
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .ok_or_else(|| invalid("edit_file effect old_text must be non-empty"))?;
    let new_text = object
        .get("new_text")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("edit_file effect new_text must be a string"))?;
    let before = sha(object.get("before_sha256"), "before_sha256")?;
    let after = sha(object.get("after_sha256"), "after_sha256")?;
    Ok(EditEntry {
        path,
        start_line: line,
        old_text: old_text.to_owned(),
        new_text: new_text.to_owned(),
        before_sha256: before,
        after_sha256: after,
    })
}

// Passthrough: parse boundary validating untyped JSON into typed values.
fn sha(value: Option<&Value>, field: &str) -> EffectResult<String> {
    value
        .and_then(Value::as_str)
        .filter(|text| text.len() == 64 && text.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| invalid(format!("edit_file effect requires {field}")))
}

pub(super) fn target(value: &str) -> EffectResult<String> {
    if let Some(digest) = value.strip_prefix("workspace:batch:") {
        if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(invalid(
                "edit_file batch target must use workspace:batch:<sha256>",
            ));
        }
        return Ok(format!("workspace:batch:{}", digest.to_ascii_lowercase()));
    }
    crate::btcc::effects::workspace_file::normalized_workspace_effect_target(value)
}

pub(super) fn target_for(input: &EditInput) -> EffectResult<String> {
    match input {
        EditInput::Batch { edits } => batch_target(
            &edits
                .iter()
                .map(|entry| entry.path.clone())
                .collect::<Vec<_>>(),
        ),
        EditInput::Single(entry) => Ok(format!("workspace:{}", entry.path)),
    }
}

pub(super) fn batch_target(paths: &[String]) -> EffectResult<String> {
    let body = json!({"version":1,"paths":paths});
    let encoded =
        butler_core::json::stringify_sorted(&body, &|a, b| a.encode_utf16().cmp(b.encode_utf16()))
            .map_err(|error| invalid(error.to_string()).with_source(error))?;
    Ok(format!(
        "workspace:batch:{}",
        crate::btcc::digest_identity(&encoded)
    ))
}

pub(super) fn recovery_hint(input: &EditInput) -> RecoveryHint {
    let start_line = |entry: &EditEntry| i64::try_from(entry.start_line).unwrap_or(0);
    match input {
        EditInput::Batch { edits } => RecoveryHint::Batch {
            capability: "edit_file".into(),
            entries: edits
                .iter()
                .map(|entry| RecoveryEntry {
                    path: entry.path.clone(),
                    start_line: start_line(entry),
                    before_sha256: entry.before_sha256.clone(),
                    after_sha256: entry.after_sha256.clone(),
                })
                .collect(),
        },
        EditInput::Single(entry) => RecoveryHint::Single {
            capability: "edit_file".into(),
            start_line: start_line(entry),
            before_sha256: entry.before_sha256.clone(),
            after_sha256: entry.after_sha256.clone(),
        },
    }
}
