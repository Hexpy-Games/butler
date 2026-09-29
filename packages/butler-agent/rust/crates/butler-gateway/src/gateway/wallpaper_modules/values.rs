//! Checks a source's `params` / `paramsDark` against its module manifest, so
//! a model caller learns the exact field at fault and what it accepts.
//! Values the settings screen writes are resolved leniently by the renderer;
//! the agent route refuses what the renderer would silently replace.

use serde_json::{Value, json};

use super::manifest::{ParamKind, ParamSpec, WallpaperModule, is_hex, is_hex_list};
use crate::gateway::AppWallpaperRejection;

/// `values` (a params object, if present) at `path`, e.g. `source.params`.
pub(crate) fn check_values(
    module: &WallpaperModule,
    values: Option<&Value>,
    path: &str,
) -> Result<(), AppWallpaperRejection> {
    let Some(values) = values else {
        return Ok(());
    };
    let Some(values) = values.as_object() else {
        return Err(AppWallpaperRejection::invalid(
            path,
            "must be an object of parameter values keyed by parameter key",
            Some(keys(module)),
        ));
    };
    values
        .iter()
        .try_for_each(|(key, value)| check_value(module, key, value, &format!("{path}.{key}")))
}

fn check_value(
    module: &WallpaperModule,
    key: &str,
    value: &Value,
    field: &str,
) -> Result<(), AppWallpaperRejection> {
    let Some(ParamSpec { kind, .. }) = module.param(key) else {
        let rule = if module.params.is_empty() {
            format!("is not a parameter of {}, which takes none", module.id)
        } else {
            format!("is not a parameter of {}", module.id)
        };
        return Err(AppWallpaperRejection::invalid(
            field,
            &rule,
            Some(keys(module)),
        ));
    };
    let (valid, rule, allowed) = match kind {
        ParamKind::Number { min, max, step } => (
            value
                .as_f64()
                .is_some_and(|n| n.is_finite() && n >= *min && n <= *max),
            format!("must be a number from {min} to {max}"),
            json!({"min": min, "max": max, "step": step}),
        ),
        ParamKind::Boolean => (
            value.is_boolean(),
            "must be true or false".to_owned(),
            json!([true, false]),
        ),
        ParamKind::Enum { options } => (
            value
                .as_str()
                .is_some_and(|value| options.iter().any(|o| o == value)),
            format!("must be one of {}", options.join(", ")),
            json!(options),
        ),
        ParamKind::Color => (
            is_hex(value),
            "must be a \"#RRGGBB\" color".to_owned(),
            json!("#RRGGBB"),
        ),
        ParamKind::Palette { size, presets } => palette(value, *size, presets),
    };
    if valid {
        Ok(())
    } else {
        Err(AppWallpaperRejection::invalid(field, &rule, Some(allowed)))
    }
}

/// A palette is a preset name or exactly `size` colors.
fn palette(value: &Value, size: usize, presets: &[String]) -> (bool, String, Value) {
    let preset = value
        .as_str()
        .is_some_and(|name| presets.iter().any(|preset| preset == name));
    let rule = if presets.is_empty() {
        format!("must be a list of {size} \"#RRGGBB\" colors")
    } else {
        format!(
            "must be a preset name ({}) or a list of {size} \"#RRGGBB\" colors",
            presets.join(", ")
        )
    };
    let allowed = json!({"presets": presets, "colors": size});
    (preset || is_hex_list(value, size), rule, allowed)
}

fn keys(module: &WallpaperModule) -> Value {
    Value::Array(
        module
            .params
            .iter()
            .map(|param| Value::String(param.key.clone()))
            .collect(),
    )
}
