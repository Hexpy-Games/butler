//! DS: manifestParams.ts, values.ts `resolveWallpaperValues` and filters.rs wp_p0..wp_p5 packing.
use serde_json::Value;

use super::{WallpaperParams, WallpaperTone};

/// The packed uniforms of a manifest's params: the first accepted candidate per param.
pub(super) fn resolve(
    manifest: &Value,
    values: &WallpaperParams,
    tone: WallpaperTone,
) -> [[f32; 4]; 6] {
    let mut packed = [[0.; 4]; 6];
    let mut cursor = 0;
    for spec in manifest["params"].as_array().into_iter().flatten() {
        let key = spec["key"].as_str().unwrap_or_default();
        let light = values.params.get(key);
        let candidates = if tone == WallpaperTone::Dark {
            [
                values.params_dark.get(key),
                spec.get("defaultDark"),
                light,
                spec.get("default"),
            ]
        } else {
            [light, spec.get("default"), None, None]
        };
        let value = candidates
            .into_iter()
            .flatten()
            .find_map(|candidate| accept(spec, candidate, tone))
            .unwrap_or(Value::Null);
        match spec["type"].as_str() {
            Some("color") => color(&mut packed, &mut cursor, &value),
            Some("palette") => {
                for value in value.as_array().into_iter().flatten() {
                    color(&mut packed, &mut cursor, value);
                }
            }
            _ => {
                packed[cursor / 4][cursor % 4] = scalar(spec, &value);
                cursor += 1;
            }
        }
    }
    packed
}

fn is_hex(value: &Value) -> bool {
    value.as_str().is_some_and(|hex| {
        hex.len() == 7 && hex.starts_with('#') && hex[1..].chars().all(|c| c.is_ascii_hexdigit())
    })
}

/// `accept` in values.ts: the candidate when it fits the spec.
fn accept(spec: &Value, value: &Value, tone: WallpaperTone) -> Option<Value> {
    match spec["type"].as_str()? {
        "number" => {
            let number = value.as_f64()?;
            let clamped = number.clamp(
                spec["min"].as_f64().unwrap_or(f64::MIN),
                spec["max"].as_f64().unwrap_or(f64::MAX),
            );
            Some(Value::from(clamped))
        }
        "boolean" => value.is_boolean().then(|| value.clone()),
        "enum" => {
            let name = value.as_str()?;
            spec["options"]
                .as_array()?
                .iter()
                .any(|option| option.get("value").unwrap_or(option) == name)
                .then(|| value.clone())
        }
        "color" => is_hex(value).then(|| value.clone()),
        "palette" => {
            let colors = match value.as_str() {
                Some(name) => &spec["presets"][name][tone.as_str()],
                None => value,
            };
            let list = colors.as_array()?;
            let size = usize::try_from(spec["size"].as_u64()?).ok()?;
            (list.len() == size && list.iter().all(is_hex)).then(|| colors.clone())
        }
        _ => None,
    }
}

fn color(packed: &mut [[f32; 4]; 6], cursor: &mut usize, value: &Value) {
    *cursor = cursor.div_ceil(4) * 4;
    let hex = value.as_str().unwrap_or("").trim_start_matches('#');
    for (index, channel) in packed[*cursor / 4][..3].iter_mut().enumerate() {
        *channel = hex
            .get(index * 2..index * 2 + 2)
            .and_then(|s| u8::from_str_radix(s, 16).ok())
            .map_or(0., |v| f32::from(v) / 255.);
    }
    *cursor += 4;
}

#[expect(
    clippy::cast_possible_truncation,
    reason = "manifest numbers become shader f32 uniforms"
)]
fn scalar(spec: &Value, value: &Value) -> f32 {
    match spec["type"].as_str() {
        Some("boolean") => f32::from(u8::from(value.as_bool().unwrap_or(false))),
        Some("enum") => spec["options"]
            .as_array()
            .and_then(|options| {
                options
                    .iter()
                    .position(|option| option.get("value").unwrap_or(option) == value)
            })
            .unwrap_or(0) as f32,
        Some("number") => value.as_f64().unwrap_or(0.).clamp(
            spec["min"].as_f64().unwrap_or(f64::MIN),
            spec["max"].as_f64().unwrap_or(f64::MAX),
        ) as f32,
        _ => 0.,
    }
}
