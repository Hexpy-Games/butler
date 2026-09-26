use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::btcc::effects::contracts::{EffectFailure, EffectResult};

fn invalid(message: impl Into<String>) -> EffectFailure {
    EffectFailure::policy("effect_request_invalid", message)
}
fn required(value: &str, field: &str) -> EffectResult<String> {
    let trimmed = crate::public_text::trim_js_whitespace(value);
    if trimmed.is_empty() {
        Err(invalid(format!(
            "write_file effect {field} must be a non-empty string"
        )))
    } else {
        Ok(trimmed.to_owned())
    }
}
fn absolute_windows(value: &str) -> bool {
    value.starts_with('\\')
        || value.starts_with("//")
        || value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphabetic)
            && value.as_bytes().get(1) == Some(&b':')
            && matches!(value.as_bytes().get(2), Some(b'/' | b'\\'))
}
pub(super) fn relative(value: &str) -> EffectResult<String> {
    let trimmed = required(value, "path")?;
    if trimmed.contains('\0') {
        return Err(invalid("write_file effect path contains a null byte"));
    }
    if Path::new(&trimmed).is_absolute() || absolute_windows(&trimmed) {
        return Err(invalid("write_file effect path must be workspace-relative"));
    }
    let slash = trimmed.replace('\\', "/");
    if slash.split('/').any(|part| part == "..") {
        return Err(invalid(
            "write_file effect path cannot traverse a parent directory",
        ));
    }
    let parts: Vec<_> = slash
        .split('/')
        .filter(|part| !part.is_empty() && *part != ".")
        .collect();
    if parts.is_empty() {
        return Err(invalid(
            "write_file effect path must identify one workspace file",
        ));
    }
    let mut normalized = parts.join("/");
    if slash.ends_with('/') {
        normalized.push('/');
    }
    Ok(normalized)
}
pub(super) fn contained(workspace: &Path, value: &str) -> EffectResult<String> {
    let trimmed = required(value, "path")?;
    if !Path::new(&trimmed).is_absolute() && !absolute_windows(&trimmed) {
        return relative(&trimmed);
    }
    let workspace = lexical_absolute(workspace)?;
    let absolute = lexical_absolute(Path::new(&trimmed))?;
    let contained = absolute
        .strip_prefix(&workspace)
        .map_err(|_| invalid("write_file effect path must identify a file inside the workspace"))?;
    let value = contained.to_string_lossy();
    if value.is_empty() || value.starts_with("..") {
        return Err(invalid(
            "write_file effect path must identify a file inside the workspace",
        ));
    }
    relative(&value)
}
fn lexical_absolute(path: &Path) -> EffectResult<PathBuf> {
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|error| invalid(error.to_string()))?
            .join(path)
    };
    let mut clean = PathBuf::new();
    for part in path.components() {
        match part {
            std::path::Component::ParentDir => {
                clean.pop();
            }
            std::path::Component::CurDir => {}
            other => clean.push(other.as_os_str()),
        }
    }
    Ok(clean)
}
pub(super) fn input(value: &Value, workspace: &Path) -> EffectResult<Value> {
    let record = value
        .as_object()
        .ok_or_else(|| invalid("write_file effect input must be an object"))?;
    let unknown = record
        .keys()
        .filter(|key| {
            !matches!(
                key.as_str(),
                "path" | "content" | "create_parents" | "overwrite" | "expected_sha256"
            )
        })
        .cloned()
        .collect::<Vec<_>>();
    if !unknown.is_empty() {
        return Err(invalid(format!(
            "write_file effect rejects unknown input: {}",
            unknown.join(", ")
        )));
    }
    let content = record
        .get("content")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("write_file effect content must be a string"))?;
    let create_parents = match record.get("create_parents") {
        None => false,
        Some(Value::Bool(value)) => *value,
        _ => {
            return Err(invalid(
                "write_file effect create_parents must be a boolean",
            ));
        }
    };
    let path = record
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("write_file effect path must be a non-empty string"))?;
    let mut normalized = serde_json::json!({"path":contained(workspace,path)?,"content":content,"create_parents":create_parents});
    if let Some(overwrite) = record.get("overwrite") {
        let overwrite = overwrite
            .as_bool()
            .ok_or_else(|| invalid("write_file effect overwrite must be a boolean"))?;
        normalized["overwrite"] = Value::Bool(overwrite);
    }
    if let Some(expected) = record.get("expected_sha256") {
        let expected = expected
            .as_str()
            .filter(|value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
            .ok_or_else(|| invalid("write_file effect expected_sha256 must be a SHA-256 digest"))?;
        normalized["expected_sha256"] = Value::String(expected.to_ascii_lowercase());
    }
    Ok(normalized)
}
pub(super) fn target(value: &str) -> EffectResult<String> {
    let value = required(value, "target")?;
    let rest = value
        .strip_prefix("workspace:")
        .ok_or_else(|| invalid("write_file effect target must use workspace:<relative-path>"))?;
    Ok(format!("workspace:{}", relative(rest)?))
}
