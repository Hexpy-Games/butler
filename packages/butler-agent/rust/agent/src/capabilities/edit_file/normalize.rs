use serde_json::{Map, Value};

use crate::workspace::ExactEdit;

use super::super::arguments;

pub(super) fn single(args: &Map<String, Value>) -> Result<ExactEdit, Value> {
    let allowed = [
        "path",
        "start_line",
        "old_text",
        "new_text",
        "expected_sha256",
        "workspace_root",
    ];
    if let Some(unknown) = args.keys().find(|key| !allowed.contains(&key.as_str())) {
        return Err(super::invalid(
            format!("Unknown single edit field: {unknown}."),
            "Use only path, start_line, old_text, new_text, and expected_sha256.",
        ));
    }
    let path = args
        .get("path")
        .and_then(Value::as_str)
        .map(crate::public_text::trim_js_whitespace)
        .filter(|path| !path.is_empty())
        .ok_or_else(|| {
            super::invalid(
                "path is required for a single edit.",
                "Retry with a workspace-relative path.",
            )
        })?;
    let old_text = args
        .get("old_text")
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .ok_or_else(|| {
            super::invalid(
                "old_text must be a non-empty string.",
                "Copy one exact existing text range into old_text.",
            )
        })?;
    let new_text = args
        .get("new_text")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            super::invalid(
                "new_text must be a string.",
                "Use an empty string to remove old_text or provide replacement text.",
            )
        })?;
    if old_text == new_text {
        return Err(super::no_change(
            "old_text and new_text are identical, so no file change was requested.",
        ));
    }
    let start_line = arguments::start_line(args.get("start_line")).map_err(|_| {
        super::invalid(
            "start_line must be a positive integer.",
            "Retry with a one-based line number or omit start_line.",
        )
    })?;
    let expected_sha256 = arguments::sha256(args.get("expected_sha256")).map_err(|_| {
        super::invalid(
            "expected_sha256 must be a 64-character hexadecimal SHA-256 digest when supplied.",
            "Retry with the complete current lowercase or uppercase SHA-256 or omit it.",
        )
    })?;
    Ok(ExactEdit {
        index: 0,
        path: path.into(),
        old_text: old_text.into(),
        new_text: new_text.into(),
        start_line,
        expected_sha256,
    })
}

pub(super) fn batch(value: &Value) -> Result<Vec<ExactEdit>, Value> {
    let items = value
        .as_array()
        .filter(|items| (2..=20).contains(&items.len()))
        .ok_or_else(|| {
            super::invalid(
                "edits must contain 2-20 entries.",
                "Retry with 2-20 exact edit entries.",
            )
        })?;
    let mut edits = Vec::with_capacity(items.len());
    for (index, item) in items.iter().enumerate() {
        let item = item.as_object().ok_or_else(|| {
            super::invalid(
                format!("edits[{index}] must be an object."),
                "Retry with canonical edit objects.",
            )
        })?;
        let allowed = [
            "path",
            "start_line",
            "old_text",
            "new_text",
            "expected_sha256",
        ];
        if let Some(unknown) = item.keys().find(|key| !allowed.contains(&key.as_str())) {
            return Err(super::invalid(
                format!("Unknown edits[{index}] field: {unknown}."),
                "Use only path, start_line, old_text, new_text, and expected_sha256.",
            ));
        }
        let path = item
            .get("path")
            .and_then(Value::as_str)
            .map(crate::public_text::trim_js_whitespace)
            .filter(|path| !path.is_empty())
            .ok_or_else(|| {
                super::invalid(
                    format!("edits[{index}].path is required."),
                    "Retry with workspace-relative paths.",
                )
            })?;
        let old_text = item
            .get("old_text")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .ok_or_else(|| {
                super::invalid(
                    format!("edits[{index}].old_text must be non-empty."),
                    "Copy each exact existing text range.",
                )
            })?;
        let new_text = item
            .get("new_text")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                super::invalid(
                    format!("edits[{index}].new_text must be a string."),
                    "Use an empty string to remove text or provide replacement text.",
                )
            })?;
        if old_text == new_text {
            return Err(super::no_change(format!(
                "edits[{index}] has identical old_text and new_text, so no file change was requested."
            )));
        }
        let start_line = arguments::start_line(item.get("start_line")).map_err(|_| {
            super::invalid(
                format!("edits[{index}].start_line must be a positive integer."),
                "Retry with one-based line hints or omit them.",
            )
        })?;
        let expected_sha256 = arguments::sha256(item.get("expected_sha256"))
            .ok().flatten().ok_or_else(|| super::invalid(
                format!("edits[{index}].expected_sha256 must be a 64-character hexadecimal SHA-256 digest."),
                format!("Read the target for edits[{index}] and provide its current SHA-256.")))?;
        edits.push(ExactEdit {
            index,
            path: path.into(),
            old_text: old_text.into(),
            new_text: new_text.into(),
            start_line,
            expected_sha256: Some(expected_sha256),
        });
    }
    Ok(edits)
}
