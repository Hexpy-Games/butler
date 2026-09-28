//! `wallpaper.json` contract v1 (engine: 1): the checks of the UI's
//! `validateWallpaperManifest`, so built-in and user modules are accepted by
//! the same rules on both sides. Errors read like the UI's (`field: rule`).
//! The optional drawing fields are checked in [`rendering`].

mod rendering;

use serde_json::{Map, Value};

pub(crate) use rendering::is_image_file;

const MAX_ID_LENGTH: usize = 64;
const MAX_PARAMS: usize = 8;
const MAX_ENUM_OPTIONS: usize = 8;
/// The engine's `u_time` period, 5000π seconds.
const MAX_TIME_PERIOD: f64 = 5000.0 * std::f64::consts::PI;

/// Which images a module draws with.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ImageInput {
    /// A live wallpaper only.
    None,
    /// A live wallpaper or an image filter.
    Optional,
    /// An image filter only.
    Required,
}

/// One user-adjustable parameter and the values it accepts.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum ParamKind {
    Number { min: f64, max: f64, step: f64 },
    Boolean,
    Enum { options: Vec<String> },
    Color,
    Palette { size: usize, presets: Vec<String> },
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ParamSpec {
    pub(crate) key: String,
    pub(crate) kind: ParamKind,
}

/// A validated module: what the backend checks sources against, plus the
/// manifest as authored for listing.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct WallpaperModule {
    pub(crate) id: String,
    pub(crate) image: ImageInput,
    pub(crate) params: Vec<ParamSpec>,
    /// `overlay: true`: `overlay.frag` draws every frame over the cached
    /// `shader.frag`.
    pub(crate) overlay: bool,
    /// `defaultImage`: the module folder's image, drawn when a source gives
    /// none.
    pub(crate) default_image: Option<String>,
    /// `sceneTone.param`: the boolean param that makes the scene follow the
    /// time of day.
    pub(crate) scene_tone: Option<String>,
    pub(crate) manifest: Value,
}

impl WallpaperModule {
    pub(crate) fn param(&self, key: &str) -> Option<&ParamSpec> {
        self.params.iter().find(|param| param.key == key)
    }

    /// Usable as a live source: it needs no image, or brings its own.
    pub(crate) fn is_live(&self) -> bool {
        self.image != ImageInput::Required || self.default_image.is_some()
    }

    /// Usable as an image source's filter.
    pub(crate) fn is_filter(&self) -> bool {
        self.image != ImageInput::None
    }
}

/// Parses `wallpaper.json` text; every contract error is reported.
pub(crate) fn parse(text: &str) -> Result<WallpaperModule, Vec<String>> {
    let manifest = serde_json::from_str(text)
        .map_err(|error| vec![format!("manifest: invalid JSON ({error})")])?;
    validate(manifest)
}

pub(crate) fn validate(manifest: Value) -> Result<WallpaperModule, Vec<String>> {
    let Some(raw) = manifest.as_object() else {
        return Err(vec!["manifest: must be an object".into()]);
    };
    let mut errors = Vec::new();
    let id = text(raw, "id").filter(|id| is_module_id(id));
    if id.is_none() {
        errors.push(format!(
            "id: must match ^[a-z0-9]+(\\.[a-z0-9-]+)+$ and be at most {MAX_ID_LENGTH} chars"
        ));
    }
    if !is_label(raw.get("name")) {
        errors.push("name: needs non-empty en and ko".into());
    }
    if !text(raw, "version").is_some_and(is_semver) {
        errors.push("version: must be semver".into());
    }
    if raw.get("engine").and_then(Value::as_u64) != Some(1) {
        errors.push("engine: must be 1".into());
    }
    if !matches!(text(raw, "motion"), Some("static" | "animated")) {
        errors.push("motion: must be static or animated".into());
    }
    let image = match text(raw, "image") {
        Some("none") => Some(ImageInput::None),
        Some("optional") => Some(ImageInput::Optional),
        Some("required") => Some(ImageInput::Required),
        _ => {
            errors.push("image: must be none, optional or required".into());
            None
        }
    };
    if raw.get("timePeriod").is_some_and(|period| {
        !period
            .as_f64()
            .is_some_and(|period| period > 0.0 && period <= MAX_TIME_PERIOD)
    }) {
        errors.push("timePeriod: must be seconds in (0, 5000*PI]".into());
    }
    let params = params(raw.get("params"), &mut errors);
    let rendering = rendering::rendering(raw, &params, &mut errors);
    match (id, image, errors.is_empty()) {
        (Some(id), Some(image), true) => Ok(WallpaperModule {
            id: id.to_owned(),
            image,
            params,
            overlay: rendering.overlay,
            default_image: rendering.default_image,
            scene_tone: rendering.scene_tone,
            manifest,
        }),
        _ => Err(errors),
    }
}

fn params(raw: Option<&Value>, errors: &mut Vec<String>) -> Vec<ParamSpec> {
    let Some(entries) = raw.and_then(Value::as_array) else {
        errors.push("params: must be an array".into());
        return Vec::new();
    };
    if entries.len() > MAX_PARAMS {
        errors.push(format!("params: at most {MAX_PARAMS}"));
    }
    let mut specs: Vec<ParamSpec> = Vec::new();
    for (index, entry) in entries.iter().enumerate() {
        let at = format!("params[{index}]");
        let Some(spec) = param(entry, &at, errors) else {
            continue;
        };
        if specs.iter().any(|seen| seen.key == spec.key) {
            errors.push(format!("{at}.key: duplicate {}", spec.key));
        }
        specs.push(spec);
    }
    specs
}

fn param(raw: &Value, at: &str, errors: &mut Vec<String>) -> Option<ParamSpec> {
    let Some(raw) = raw.as_object() else {
        errors.push(format!("{at}: must be an object"));
        return None;
    };
    let key = text(raw, "key").filter(|key| is_param_key(key));
    if key.is_none() {
        errors.push(format!("{at}.key: must match ^[a-z][A-Za-z0-9]{{0,23}}$"));
    }
    if !is_label(raw.get("label")) {
        errors.push(format!("{at}.label: needs non-empty en and ko"));
    }
    let kind = text(raw, "type");
    if raw.contains_key("control") && kind != Some("number") {
        errors.push(format!("{at}.control: only number params take a control"));
    }
    let kind = match kind {
        Some("number") => number(raw, at, errors),
        Some("enum") => options(raw, at, errors),
        Some("palette") => palette(raw, at, errors),
        Some("boolean") => {
            defaults(raw, Value::is_boolean, "must be a boolean", at, errors);
            Some(ParamKind::Boolean)
        }
        Some("color") => {
            defaults(raw, is_hex, "must be #RRGGBB", at, errors);
            Some(ParamKind::Color)
        }
        other => {
            errors.push(format!("{at}.type: unknown {}", other.unwrap_or("type")));
            None
        }
    }?;
    Some(ParamSpec {
        key: key?.to_owned(),
        kind,
    })
}

fn number(raw: &Map<String, Value>, at: &str, errors: &mut Vec<String>) -> Option<ParamKind> {
    let bound = |name| {
        raw.get(name)
            .and_then(Value::as_f64)
            .filter(|n| n.is_finite())
    };
    let (Some(min), Some(max), Some(step)) = (bound("min"), bound("max"), bound("step")) else {
        errors.push(format!("{at}: min, max and step must be numbers"));
        return None;
    };
    if min >= max {
        errors.push(format!("{at}: min must be below max"));
    }
    if step <= 0.0 {
        errors.push(format!("{at}.step: must be positive"));
    }
    if raw
        .get("control")
        .is_some_and(|control| control.as_str() != Some("shuffle"))
    {
        errors.push(format!("{at}.control: must be shuffle"));
    }
    let in_range = |value: &Value| value.as_f64().is_some_and(|n| n >= min && n <= max);
    let rule = format!("must be a number in [{min}, {max}]");
    defaults(raw, in_range, &rule, at, errors);
    Some(ParamKind::Number { min, max, step })
}

/// Enum options: value strings, or `{value, label: {en, ko}}` entries.
fn options(raw: &Map<String, Value>, at: &str, errors: &mut Vec<String>) -> Option<ParamKind> {
    let entries = raw.get("options").and_then(Value::as_array);
    let values: Option<Vec<String>> = entries.and_then(|entries| {
        entries
            .iter()
            .map(|entry| entry.get("value").unwrap_or(entry).as_str())
            .map(|value| value.filter(|value| !value.is_empty()).map(str::to_owned))
            .collect()
    });
    let unique = |values: &Vec<String>| {
        (1..=MAX_ENUM_OPTIONS).contains(&values.len())
            && values
                .iter()
                .enumerate()
                .all(|(index, value)| !values[..index].contains(value))
    };
    let Some(options) = values.filter(unique) else {
        errors.push(format!(
            "{at}.options: 1 to {MAX_ENUM_OPTIONS} unique values"
        ));
        return None;
    };
    for (index, entry) in entries.into_iter().flatten().enumerate() {
        if entry.is_object() && !is_label(entry.get("label")) {
            errors.push(format!(
                "{at}.options[{index}].label: needs non-empty en and ko"
            ));
        }
    }
    let known = |value: &Value| {
        value
            .as_str()
            .is_some_and(|value| options.iter().any(|o| o == value))
    };
    defaults(raw, known, "must be one of the options", at, errors);
    Some(ParamKind::Enum { options })
}

fn palette(raw: &Map<String, Value>, at: &str, errors: &mut Vec<String>) -> Option<ParamKind> {
    let Some(size) = raw
        .get("size")
        .and_then(Value::as_u64)
        .and_then(|size| usize::try_from(size).ok())
        .filter(|size| (2..=6).contains(size))
    else {
        errors.push(format!("{at}.size: must be an integer in [2, 6]"));
        return None;
    };
    let rule = format!("must be {size} #RRGGBB colors");
    defaults(raw, |value| is_hex_list(value, size), &rule, at, errors);
    let mut presets = Vec::new();
    match raw.get("presets") {
        None => {}
        Some(Value::Object(entries)) => {
            for (name, preset) in entries {
                for tone in ["light", "dark"] {
                    if !preset
                        .get(tone)
                        .is_some_and(|colors| is_hex_list(colors, size))
                    {
                        errors.push(format!("{at}.presets.{name}.{tone}: {rule}"));
                    }
                }
                presets.push(name.clone());
            }
        }
        Some(_) => errors.push(format!("{at}.presets: must be an object")),
    }
    Some(ParamKind::Palette { size, presets })
}

/// `default` (required) and `defaultDark` (optional) must satisfy `check`.
fn defaults(
    raw: &Map<String, Value>,
    check: impl Fn(&Value) -> bool,
    rule: &str,
    at: &str,
    errors: &mut Vec<String>,
) {
    if !raw.get("default").is_some_and(&check) {
        errors.push(format!("{at}.default: {rule}"));
    }
    if raw.get("defaultDark").is_some_and(|value| !check(value)) {
        errors.push(format!("{at}.defaultDark: {rule}"));
    }
}

fn text<'a>(raw: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    raw.get(key).and_then(Value::as_str)
}

pub(crate) fn is_label(value: Option<&Value>) -> bool {
    value.is_some_and(|label| {
        ["en", "ko"].iter().all(|locale| {
            label
                .get(locale)
                .and_then(Value::as_str)
                .is_some_and(|text| !text.trim().is_empty())
        })
    })
}

/// `^[a-z0-9]+(\.[a-z0-9-]+)+$`, at most 64 characters.
pub(crate) fn is_module_id(id: &str) -> bool {
    let Some((first, rest)) = Some(id)
        .filter(|id| id.len() <= MAX_ID_LENGTH)
        .and_then(|id| id.split_once('.'))
    else {
        return false;
    };
    let segment = |segment: &str, hyphen: bool| {
        !segment.is_empty()
            && segment.bytes().all(|byte| {
                byte.is_ascii_lowercase() || byte.is_ascii_digit() || (hyphen && byte == b'-')
            })
    };
    segment(first, false) && rest.split('.').all(|part| segment(part, true))
}

/// `^[a-z][A-Za-z0-9]{0,23}$`.
pub(crate) fn is_param_key(key: &str) -> bool {
    let mut bytes = key.bytes();
    key.len() <= 24
        && bytes.next().is_some_and(|byte| byte.is_ascii_lowercase())
        && bytes.all(|byte| byte.is_ascii_alphanumeric())
}

/// `MAJOR.MINOR.PATCH`, with optional `-pre.release` and `+build` parts.
fn is_semver(version: &str) -> bool {
    let tag = |part: &str| {
        !part.is_empty()
            && part
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b".-".contains(&byte))
    };
    let (rest, build) = match version.split_once('+') {
        Some((rest, build)) => (rest, Some(build)),
        None => (version, None),
    };
    let (core, pre) = match rest.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (rest, None),
    };
    let numbers: Vec<_> = core.split('.').collect();
    numbers.len() == 3
        && numbers
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
        && pre.is_none_or(tag)
        && build.is_none_or(tag)
}

/// `#RRGGBB`.
pub(crate) fn is_hex(value: &Value) -> bool {
    value
        .as_str()
        .and_then(|color| color.strip_prefix('#'))
        .is_some_and(|hex| hex.len() == 6 && hex.bytes().all(|byte| byte.is_ascii_hexdigit()))
}

pub(crate) fn is_hex_list(value: &Value, size: usize) -> bool {
    value
        .as_array()
        .is_some_and(|colors| colors.len() == size && colors.iter().all(is_hex))
}
