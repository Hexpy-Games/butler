//! The `wallpaper` app setting: strict PATCH validation, the effective view of
//! the stored value, and its derivation from the legacy `main_screen_theme*`
//! keys, which stay readable and writable while clients move over.
//!
//! Shape (camelCase fields, as the renderer reads them):
//! `{ source, motion: "auto" | "paused", pauseOnBattery: bool, origin:
//! "legacy" | "chosen" }` (`origin` is set by the server, see [`project`]),
//! where
//! `source` is `{kind: "none"}`, `{kind: "live", module, params?, paramsDark?}`
//! or `{kind: "image", asset, fit: "cover" | "contain", dim, blur, filter?}` and
//! `filter` is `{module, params?, paramsDark?}`.
//!
//! A project's `dashboard_preferences_json.wallpaper` is `"inherit"` or a
//! `source` under the same rules; see [`check_project`].
//!
//! Asset ids name entries of the wallpaper asset store. They match
//! `^wp_[a-z0-9]{8,64}$`, so an id is always a single safe path component.

use serde_json::{Map, Value, json};

use super::view::legacy_source;
use crate::gateway::GatewayApplicationError;

pub(super) const KEY: &str = "wallpaper";
/// Where the stored `source` came from: `"legacy"` (derived from the legacy
/// keys, which may re-derive it) or `"chosen"` (written through `wallpaper`
/// by the user or the agent, which a legacy patch never overwrites).
const ORIGIN: &str = "origin";
const LEGACY: &str = "legacy";
const CHOSEN: &str = "chosen";

const MODULE_RULE: &str = "must match ^[a-z0-9]+(\\.[a-z0-9-]+)+$ and be at most 64 characters";
const ASSET_RULE: &str = "must match ^wp_[a-z0-9]{8,64}$";
const PARAM_VALUE_RULE: &str = "must be a finite number, a boolean, a string of at most 64 \
     characters, or an array of 1 to 6 \"#RRGGBB\" colors";
const MAX_PARAMS: usize = 16;

/// A rejected field: its dotted path from `wallpaper` and the rule it broke.
struct Invalid {
    path: String,
    rule: String,
}

type Checked = Result<(), Invalid>;

/// Validates a PATCH value, which sets any non-empty subset of `source`,
/// `motion` and `pauseOnBattery`. A rejection names the offending field and
/// its rule so a model caller can correct the request.
/// `origin` is the server's own marker: a PATCH that echoes it back has it
/// dropped, never trusted.
pub(super) fn sanitize(value: &Value) -> Result<Value, GatewayApplicationError> {
    let mut value = value.clone();
    if let Some(setting) = value.as_object_mut() {
        setting.remove(ORIGIN);
    }
    check_setting(&value)
        .map(|()| value)
        .map_err(|Invalid { path, rule }| rejected(&path, &rule))
}

/// The effective `wallpaper.source` of a settings view or projection.
pub(super) fn source(settings: &Value) -> Value {
    settings
        .get(KEY)
        .and_then(|setting| setting.get("source"))
        .cloned()
        .unwrap_or(Value::Null)
}

/// Checks an agent-written source (`"source"` paths) under the setting's
/// source rules; the error is the field and its rule.
pub(in crate::gateway::application) fn check_agent_source(
    value: &Value,
) -> Result<(), (String, String)> {
    check_source(value, "source").map_err(|Invalid { path, rule }| (path, rule))
}

/// The asset a validated PATCH points `wallpaper.source` at, if any.
pub(super) fn patched_image_asset(patch: &Value) -> Option<&str> {
    source_image_asset(patch.get(KEY)?.get("source")?)
}

/// The asset an image source names; other sources (and `'inherit'`) name none.
pub(in crate::gateway::application) fn source_image_asset(source: &Value) -> Option<&str> {
    (source.get("kind")?.as_str()? == "image")
        .then(|| source.get("asset")?.as_str())
        .flatten()
}

/// A PATCH named an asset the wallpaper store does not hold.
pub(super) fn unknown_asset() -> GatewayApplicationError {
    rejected(
        "wallpaper.source.asset",
        "must name a stored wallpaper image",
    )
}

fn rejected(path: &str, rule: &str) -> GatewayApplicationError {
    GatewayApplicationError::Public {
        status: 400,
        code: "settings_wallpaper_invalid".into(),
        message: format!("Invalid wallpaper setting: {path} {rule}."),
        source: None,
    }
}

/// Validates a project wallpaper (`dashboard_preferences_json.wallpaper`):
/// `"inherit"` or a source under the setting's source rules. A rejection
/// names the field (`wallpaper.<field>`) and its rule.
pub(in crate::gateway::application) fn check_project(
    value: &Value,
) -> Result<(), GatewayApplicationError> {
    check_project_value(value).map_err(|Invalid { path, rule }| project_rejected(&path, &rule))
}

/// A project PATCH named an asset the wallpaper store does not hold.
pub(in crate::gateway::application) fn project_unknown_asset() -> GatewayApplicationError {
    project_rejected("wallpaper.asset", "must name a stored wallpaper image")
}

/// The effective project wallpaper: the stored value when valid, otherwise
/// `"inherit"`, which follows the global setting.
pub(in crate::gateway::application) fn project_view(stored: Option<&Value>) -> Value {
    stored
        .filter(|value| check_project_value(value).is_ok())
        .cloned()
        .unwrap_or_else(|| json!(PROJECT_INHERIT))
}

const PROJECT_INHERIT: &str = "inherit";

fn check_project_value(value: &Value) -> Checked {
    match value {
        Value::String(text) if text == PROJECT_INHERIT => Ok(()),
        Value::Object(_) => check_source(value, KEY),
        _ => Err(invalid(KEY, "must be \"inherit\" or an object with a kind")),
    }
}

fn project_rejected(path: &str, rule: &str) -> GatewayApplicationError {
    GatewayApplicationError::Public {
        status: 400,
        code: "project_wallpaper_invalid".into(),
        message: format!("Invalid project wallpaper: {path} {rule}."),
        source: None,
    }
}

/// The source the legacy keys describe, from their normalized values.
pub(super) fn from_legacy(theme: &str, preset: &str, colors: &[String]) -> Value {
    match theme {
        "none" => json!({"kind": "none"}),
        "silk" => json!({"kind": "live", "module": "butler.silk"}),
        _ => {
            let palette = if preset == "custom" {
                json!(colors)
            } else {
                json!(preset)
            };
            json!({"kind": "live", "module": "butler.bloom", "params": {"colors": palette}})
        }
    }
}

/// The effective setting: the stored fields over the defaults, with the
/// legacy-derived `source` until one is stored. An invalid stored value is
/// ignored as a whole.
pub(super) fn view(stored: Option<&Value>, legacy: Value) -> Value {
    let mut setting = Map::new();
    setting.insert("source".into(), legacy);
    setting.insert(ORIGIN.into(), json!(LEGACY));
    setting.insert("motion".into(), json!("auto"));
    setting.insert("pauseOnBattery".into(), json!(false));
    if let Some(stored) = stored
        .filter(|value| check_setting(value).is_ok())
        .and_then(Value::as_object)
    {
        setting.extend(stored.clone());
    }
    Value::Object(setting)
}

/// Resolves `wallpaper` in a settings projection. A PATCH that sets it is the
/// source of truth, and one that sets `source` marks it `origin: "chosen"`.
/// Otherwise a change to the source the legacy keys describe re-derives
/// `source` (`origin: "legacy"`) and keeps the motion preferences, but only
/// while the current source was derived from them. A chosen source is never
/// overwritten, even when it equals what the legacy keys describe. A stored
/// source from before the marker counts as derived only while it still
/// equals the legacy keys' source.
pub(super) fn project(current: &Value, patch: &Value, output: &mut Value) {
    let Some(output) = output.as_object_mut() else {
        return;
    };
    let derived = legacy_source(output);
    let mut setting = current
        .get(KEY)
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if let Some(update) = patch.get(KEY).and_then(Value::as_object) {
        setting.extend(update.clone());
        if update.contains_key("source") {
            setting.insert(ORIGIN.into(), json!(CHOSEN));
        }
    } else {
        let previous = current.as_object().map(legacy_source);
        let follows_legacy = match setting.get(ORIGIN).and_then(Value::as_str) {
            Some(CHOSEN) => false,
            Some(_) => true,
            None => setting
                .get("source")
                .is_none_or(|source| Some(source) == previous.as_ref()),
        };
        if follows_legacy && previous.as_ref() != Some(&derived) {
            setting.insert("source".into(), derived.clone());
            setting.insert(ORIGIN.into(), json!(LEGACY));
        }
    }
    let setting = view(Some(&Value::Object(setting)), derived);
    output.insert(KEY.into(), setting);
}

fn check_setting(value: &Value) -> Checked {
    let setting = value
        .as_object()
        .filter(|setting| !setting.is_empty())
        .ok_or_else(|| {
            invalid(
                KEY,
                "must be an object setting source, motion or pauseOnBattery",
            )
        })?;
    check_fields(
        setting,
        KEY,
        &["source", "motion", "pauseOnBattery", ORIGIN],
        &[],
    )?;
    setting.iter().try_for_each(|(key, value)| {
        let path = format!("{KEY}.{key}");
        match key.as_str() {
            "source" => check_source(value, &path),
            ORIGIN => require(
                matches!(value.as_str(), Some(LEGACY | CHOSEN)),
                &path,
                "must be \"legacy\" or \"chosen\"",
            ),
            "motion" => require(
                matches!(value.as_str(), Some("auto" | "paused")),
                &path,
                "must be \"auto\" or \"paused\"",
            ),
            _ => require(value.is_boolean(), &path, "must be a boolean"),
        }
    })
}

fn check_source(value: &Value, path: &str) -> Checked {
    let source = value
        .as_object()
        .ok_or_else(|| invalid(path, "must be an object with a kind"))?;
    let (fields, required): (&[&str], &[&str]) = match source.get("kind").and_then(Value::as_str) {
        Some("none") => (&["kind"], &[]),
        Some("live") => (&["kind", "module", "params", "paramsDark"], &["module"]),
        Some("image") => (
            &["kind", "asset", "fit", "dim", "blur", "filter"],
            &["asset", "fit", "dim", "blur"],
        ),
        _ => {
            return Err(invalid(
                &format!("{path}.kind"),
                "must be \"none\", \"live\" or \"image\"",
            ));
        }
    };
    check_object(source, path, fields, required)
}

fn check_filter(value: &Value, path: &str) -> Checked {
    let filter = value
        .as_object()
        .ok_or_else(|| invalid(path, "must be an object with a module"))?;
    check_object(
        filter,
        path,
        &["module", "params", "paramsDark"],
        &["module"],
    )
}

fn check_object(
    object: &Map<String, Value>,
    path: &str,
    fields: &[&str],
    required: &[&str],
) -> Checked {
    check_fields(object, path, fields, required)?;
    object
        .iter()
        .try_for_each(|(key, value)| check_field(key, value, &format!("{path}.{key}")))
}

fn check_fields(
    object: &Map<String, Value>,
    path: &str,
    fields: &[&str],
    required: &[&str],
) -> Checked {
    if let Some(key) = object.keys().find(|key| !fields.contains(&key.as_str())) {
        return Err(invalid(&format!("{path}.{key}"), "is not supported here"));
    }
    match required.iter().find(|key| !object.contains_key(**key)) {
        Some(key) => Err(invalid(&format!("{path}.{key}"), "is required")),
        None => Ok(()),
    }
}

fn check_field(key: &str, value: &Value, path: &str) -> Checked {
    match key {
        "module" => require(is_module_id(value), path, MODULE_RULE),
        "params" | "paramsDark" => check_params(value, path),
        "asset" => require(is_asset_id(value), path, ASSET_RULE),
        "fit" => require(
            matches!(value.as_str(), Some("cover" | "contain")),
            path,
            "must be \"cover\" or \"contain\"",
        ),
        "dim" | "blur" => require(
            value
                .as_f64()
                .is_some_and(|number| (0.0..=1.0).contains(&number)),
            path,
            "must be a number from 0 to 1",
        ),
        "filter" => check_filter(value, path),
        _ => Ok(()),
    }
}

fn check_params(value: &Value, path: &str) -> Checked {
    let params = value
        .as_object()
        .filter(|params| params.len() <= MAX_PARAMS)
        .ok_or_else(|| invalid(path, "must be an object of at most 16 parameters"))?;
    params.iter().try_for_each(|(key, value)| {
        if !is_param_key(key) {
            let shown = key.chars().take(25).collect::<String>();
            return Err(invalid(
                path,
                format!("key {shown:?} must match ^[a-z][A-Za-z0-9]{{0,23}}$"),
            ));
        }
        require(
            is_param_value(value),
            &format!("{path}.{key}"),
            PARAM_VALUE_RULE,
        )
    })
}

fn is_module_id(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(crate::gateway::wallpaper_modules::is_module_id)
}

fn is_asset_id(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(crate::gateway::wallpapers::is_asset_id)
}

fn is_param_key(key: &str) -> bool {
    let mut bytes = key.bytes();
    key.len() <= 24
        && bytes.next().is_some_and(|byte| byte.is_ascii_lowercase())
        && bytes.all(|byte| byte.is_ascii_alphanumeric())
}

fn is_param_value(value: &Value) -> bool {
    match value {
        Value::Number(number) => number.as_f64().is_some_and(f64::is_finite),
        Value::Bool(_) => true,
        Value::String(text) => text.encode_utf16().count() <= 64,
        Value::Array(colors) => (1..=6).contains(&colors.len()) && colors.iter().all(is_hex_color),
        Value::Null | Value::Object(_) => false,
    }
}

fn is_hex_color(value: &Value) -> bool {
    value
        .as_str()
        .and_then(|color| color.strip_prefix('#'))
        .is_some_and(|hex| hex.len() == 6 && hex.bytes().all(|byte| byte.is_ascii_hexdigit()))
}

fn require(valid: bool, path: &str, rule: &str) -> Checked {
    if valid {
        Ok(())
    } else {
        Err(invalid(path, rule))
    }
}

fn invalid(path: &str, rule: impl Into<String>) -> Invalid {
    Invalid {
        path: path.to_owned(),
        rule: rule.into(),
    }
}
