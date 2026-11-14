//! DS: manifestParams.ts, values.ts defaults and filters.rs wp_p0..wp_p5 packing.
use serde_json::Value;

use super::WallpaperTone;

pub(super) fn defaults(manifest: &Value, tone: WallpaperTone) -> [[f32; 4]; 6] {
    let mut packed = [[0.; 4]; 6];
    let mut cursor = 0;
    for spec in manifest["params"].as_array().into_iter().flatten() {
        let value = if tone == WallpaperTone::Dark {
            spec.get("defaultDark").unwrap_or(&spec["default"])
        } else {
            &spec["default"]
        };
        match spec["type"].as_str() {
            Some("color") => color(&mut packed, &mut cursor, value),
            Some("palette") => {
                for value in value.as_array().into_iter().flatten() {
                    color(&mut packed, &mut cursor, value);
                }
            }
            _ => {
                packed[cursor / 4][cursor % 4] = scalar(spec, value);
                cursor += 1;
            }
        }
    }
    packed
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
