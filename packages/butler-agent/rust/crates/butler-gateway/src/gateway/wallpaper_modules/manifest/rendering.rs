//! Optional manifest fields (still engine 1) that shape how the engine draws
//! a module: `overlay` (a cached `shader.frag` under an every-frame
//! `overlay.frag`), `pixelRatio`, `imageDim`, `defaultImage` (an image in the
//! module folder) and `sceneTone` (when a real-time scene is dark). The rules
//! and messages follow the UI's `manifestOptions.ts`.

use serde_json::{Map, Value};

use super::{ParamKind, ParamSpec};

const MAX_DARK_PHASES: usize = 4;
const MAX_IMAGE_STEM: usize = 64;
const IMAGE_EXTENSIONS: [&str; 4] = [".jpg", ".jpeg", ".png", ".webp"];

/// What the backend needs of these fields; the rest stays in the manifest.
#[derive(Default)]
pub(super) struct Rendering {
    pub(super) overlay: bool,
    pub(super) default_image: Option<String>,
    pub(super) scene_tone: Option<String>,
}

pub(super) fn rendering(
    raw: &Map<String, Value>,
    params: &[ParamSpec],
    errors: &mut Vec<String>,
) -> Rendering {
    let overlay = match raw.get("overlay") {
        None => false,
        Some(Value::Bool(overlay)) => *overlay,
        Some(_) => {
            errors.push("overlay: must be a boolean".into());
            false
        }
    };
    one_of(raw, "pixelRatio", &["default", "device"], errors);
    one_of(raw, "imageDim", &["auto", "noDarkStep", "none"], errors);
    let default_image = raw.get("defaultImage").and_then(|name| {
        let Some(name) = name.as_str().filter(|name| is_image_file(name)) else {
            let rule = "must be a .jpg, .png or .webp file name beside shader.frag";
            errors.push(format!("defaultImage: {rule}"));
            return None;
        };
        if raw.get("image").and_then(Value::as_str) == Some("none") {
            errors.push("defaultImage: needs image optional or required".into());
        }
        Some(name.to_owned())
    });
    let scene_tone = raw
        .get("sceneTone")
        .and_then(|tone| scene_tone(tone, params, errors));
    Rendering {
        overlay,
        default_image,
        scene_tone,
    }
}

fn one_of(raw: &Map<String, Value>, key: &str, allowed: &[&str], errors: &mut Vec<String>) {
    let valid = |value: &Value| value.as_str().is_some_and(|text| allowed.contains(&text));
    if raw.get(key).is_some_and(|value| !valid(value)) {
        let (last, first) = allowed.split_last().unwrap_or((&"", &[]));
        errors.push(format!("{key}: must be {} or {last}", first.join(", ")));
    }
}

/// `{param, darkPhases}`: the key of a boolean param, and 1 to 4
/// `[start, end)` day-phase ranges with `0 <= start < end <= 1`. Returns the
/// param key.
fn scene_tone(tone: &Value, params: &[ParamSpec], errors: &mut Vec<String>) -> Option<String> {
    let Some(tone) = tone.as_object() else {
        errors.push("sceneTone: must be an object".into());
        return None;
    };
    let param = tone.get("param").and_then(Value::as_str).filter(|key| {
        params
            .iter()
            .any(|spec| spec.key == *key && spec.kind == ParamKind::Boolean)
    });
    if param.is_none() {
        errors.push("sceneTone.param: must name a boolean param".into());
    }
    let phases = tone.get("darkPhases").and_then(Value::as_array);
    if !phases.is_some_and(|phases| {
        (1..=MAX_DARK_PHASES).contains(&phases.len()) && phases.iter().all(is_phase)
    }) {
        errors.push(format!(
            "sceneTone.darkPhases: 1 to {MAX_DARK_PHASES} [start, end) ranges with 0 <= start < \
             end <= 1"
        ));
    }
    param.map(str::to_owned)
}

fn is_phase(phase: &Value) -> bool {
    let bounds: Option<Vec<f64>> = phase
        .as_array()
        .filter(|bounds| bounds.len() == 2)
        .and_then(|bounds| bounds.iter().map(Value::as_f64).collect());
    bounds.is_some_and(|bounds| 0.0 <= bounds[0] && bounds[0] < bounds[1] && bounds[1] <= 1.0)
}

/// A plain file name beside `shader.frag` with an image extension, as the
/// UI's `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.(?:jpe?g|png|webp)$`.
pub(crate) fn is_image_file(name: &str) -> bool {
    IMAGE_EXTENSIONS.iter().any(|extension| {
        name.strip_suffix(extension).is_some_and(|stem| {
            stem.len() <= MAX_IMAGE_STEM
                && stem
                    .bytes()
                    .next()
                    .is_some_and(|b| b.is_ascii_alphanumeric())
                && stem
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
        })
    })
}
