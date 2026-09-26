use std::borrow::Cow;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

use super::{CapabilityError, CapabilityInvocation};
use crate::workspace::MutationContext;

pub(super) fn parse(call: &Value) -> Result<Cow<'_, Map<String, Value>>, (&'static str, String)> {
    let raw = ["arguments", "input", "args"]
        .into_iter()
        .find_map(|key| call.get(key).filter(|value| !value.is_null()))
        .unwrap_or(&Value::Null);
    match raw {
        Value::String(string) => match serde_json::from_str::<Value>(string)
            .map_err(|error| ("invalid_arguments_json", error.to_string()))?
        {
            Value::Object(map) => Ok(Cow::Owned(map)),
            _ => Err((
                "invalid_arguments_shape",
                "Tool arguments JSON must decode to an object.".into(),
            )),
        },
        Value::Object(map) => Ok(Cow::Borrowed(map)),
        Value::Null => Ok(Cow::Owned(Map::new())),
        _ => Err((
            "invalid_arguments_shape",
            "Tool arguments must be an object or JSON object string.".into(),
        )),
    }
}

pub(super) fn root(
    input: &CapabilityInvocation<'_>,
    args: &Map<String, Value>,
) -> Result<PathBuf, CapabilityError> {
    if let Some(reference) = input.workspace_reference {
        return reference
            .get()
            .map_err(|error| CapabilityError { code: error.code });
    }
    if let Some(path) = input.workspace_path
        && !crate::public_text::trim_js_whitespace(&path.to_string_lossy()).is_empty()
    {
        return Ok(path.to_path_buf());
    }
    if let Some(path) = args.get("workspace_root").and_then(Value::as_str)
        && !crate::public_text::trim_js_whitespace(path).is_empty()
    {
        return Ok(PathBuf::from(path));
    }
    Ok(input.butler_data.to_path_buf())
}

pub(super) fn context(input: &CapabilityInvocation<'_>, root: PathBuf) -> MutationContext {
    let installation_root = input.installation_root.map(Path::to_path_buf);
    MutationContext {
        root,
        relative_only: input.allowed_tools_and_effects.is_some(),
        installation_root,
        protected_roots: input.protected_ledger_roots.to_vec(),
    }
}

pub(super) fn allowed(input: &CapabilityInvocation<'_>, effect: &str) -> bool {
    input
        .allowed_tools_and_effects
        .is_none_or(|items| items.iter().any(|item| item == effect))
}

pub(super) fn scope(path: &str, scopes: Option<&[String]>) -> bool {
    let Some(scopes) = scopes else {
        return true;
    };
    let target = crate::public_text::trim_js_whitespace(path).replace('\\', "/");
    let target = target.strip_prefix("./").unwrap_or(&target);
    if target.is_empty()
        || Path::new(target).is_absolute()
        || target.split('/').any(|part| part == "..")
    {
        return false;
    }
    scopes.iter().any(|scope| {
        let raw = crate::public_text::trim_js_whitespace(scope);
        if raw == "." || raw == "./" {
            return true;
        }
        let normalized = raw.replace('\\', "/");
        let normalized = normalized.strip_prefix("./").unwrap_or(&normalized);
        !normalized.is_empty()
            && (target == normalized || normalized.ends_with('/') && target.starts_with(normalized))
    })
}

pub(super) fn sha256(value: Option<&Value>) -> Result<Option<String>, ()> {
    let Some(value) = value else {
        return Ok(None);
    };
    let text = value.as_str().ok_or(())?;
    if text.len() != 64 || !text.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(());
    }
    Ok(Some(text.to_ascii_lowercase()))
}

pub(super) fn start_line(value: Option<&Value>) -> Result<Option<usize>, ()> {
    let Some(value) = value else {
        return Ok(None);
    };
    let number = js_number(value);
    if !number.is_finite()
        || number.fract() != 0.0
        || !(1.0..=9_007_199_254_740_991.0).contains(&number)
    {
        return Err(());
    }
    Ok(Some(number as usize))
}

fn js_number(value: &Value) -> f64 {
    match value {
        Value::Null => 0.0,
        Value::Bool(value) => {
            if *value {
                1.0
            } else {
                0.0
            }
        }
        Value::Number(value) => value.as_f64().unwrap_or(f64::NAN),
        Value::String(value) => parse_number(value),
        Value::Array(values) if values.is_empty() => 0.0,
        Value::Array(values) if values.len() == 1 => {
            if values[0].is_null() {
                0.0
            } else {
                js_number(&values[0])
            }
        }
        _ => f64::NAN,
    }
}

fn parse_number(value: &str) -> f64 {
    let value = crate::public_text::trim_js_whitespace(value);
    if value.is_empty() {
        return 0.0;
    }
    if let Some(digits) = value
        .strip_prefix("0x")
        .or_else(|| value.strip_prefix("0X"))
    {
        return u64::from_str_radix(digits, 16).map_or(f64::NAN, |number| number as f64);
    }
    if let Some(digits) = value
        .strip_prefix("0b")
        .or_else(|| value.strip_prefix("0B"))
    {
        return u64::from_str_radix(digits, 2).map_or(f64::NAN, |number| number as f64);
    }
    if let Some(digits) = value
        .strip_prefix("0o")
        .or_else(|| value.strip_prefix("0O"))
    {
        return u64::from_str_radix(digits, 8).map_or(f64::NAN, |number| number as f64);
    }
    value.parse::<f64>().unwrap_or(f64::NAN)
}
