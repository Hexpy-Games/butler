use serde_json::{Map, Value, json};

use crate::workspace::WorkspaceListLimits;

pub(super) struct Options {
    pub root: String,
    pub pattern: String,
    pub regex: bool,
    pub case_sensitive: bool,
    pub include: Vec<String>,
    pub exclude: Vec<String>,
    pub context_lines: usize,
    pub max_matches: usize,
    pub max_bytes_per_file: usize,
    pub max_output_bytes: usize,
    pub limits: WorkspaceListLimits,
}

fn failure(message: &str, hint: &str) -> Value {
    json!({"ok":false,"error":"invalid_arguments","message":message,
        "recovery_hint":hint,
        "evidence_capability_receipts":super::super::evidence::grep_limitation("invalid_arguments")})
}

fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value
            .as_f64()
            .is_some_and(|number| number != 0.0 && !number.is_nan()),
        Value::String(value) => !value.is_empty(),
        _ => true,
    }
}

fn js_string(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(text) => text.clone(),
        Value::Bool(value) => value.to_string(),
        Value::Number(number) => number.to_string(),
        Value::Array(values) => values.iter().map(js_string).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

fn integer(value: Option<&Value>, fallback: usize, min: usize, max: usize) -> usize {
    let Some(value) = value else {
        return fallback.clamp(min, max);
    };
    let Ok(number) = crate::json::coerce_number(value) else {
        return fallback;
    };
    if number.is_finite() {
        crate::json::saturating_usize(number.floor().max(min as f64).min(max as f64))
    } else {
        fallback
    }
}

pub(super) fn normalize(args: &Map<String, Value>) -> Result<Options, Value> {
    let pattern = crate::public_text::trim_js_whitespace(&js_string(
        args.get("pattern").unwrap_or(&Value::Null),
    ))
    .to_owned();
    let (regex, case_sensitive) = if let Some(Value::Bool(literal)) = args.get("literal") {
        (
            !literal,
            args.get("case_sensitive")
                .filter(|value| !value.is_null())
                .is_none_or(js_truthy),
        )
    } else {
        let has_mode = args.contains_key("mode");
        let has_regex = args.contains_key("regex");
        let mode = args
            .get("mode")
            .and_then(Value::as_str)
            .map(|text| crate::public_text::trim_js_whitespace(text).to_ascii_lowercase())
            .unwrap_or_default();
        if has_mode && mode != "literal" && mode != "regex" {
            return Err(failure(
                "mode must be literal or regex when supplied as a replay alias.",
                "Use literal=false for regex or literal=true for exact text.",
            ));
        }
        let alias_regex = args
            .get("regex")
            .filter(|value| !value.is_null())
            .is_some_and(js_truthy);
        if has_mode && has_regex && (mode == "regex") != alias_regex {
            return Err(failure(
                "regex and replay alias mode disagree.",
                "Provide only the literal field.",
            ));
        }
        (
            if has_regex {
                alias_regex
            } else {
                mode == "regex"
            },
            args.get("case_sensitive")
                .filter(|value| !value.is_null())
                .is_none_or(js_truthy),
        )
    };
    let include = super::super::list_files::globs(args, "include_globs", "include")
        .map_err(|(message, hint)| failure(&message, &hint))?;
    let exclude = super::super::list_files::globs(args, "exclude_globs", "exclude")
        .map_err(|(message, hint)| failure(&message, &hint))?;
    let context_lines = integer(
        args.get("context_lines")
            .filter(|value| !value.is_null())
            .or(args.get("context")),
        0,
        0,
        10,
    );
    if args.contains_key("context_lines")
        && args.contains_key("context")
        && integer(args.get("context_lines"), 0, 0, 10) != integer(args.get("context"), 0, 0, 10)
    {
        return Err(failure(
            "context_lines and replay alias context disagree.",
            "Provide only the canonical context_lines field.",
        ));
    }
    let limits = WorkspaceListLimits {
        max_results: integer(
            args.get("max_results"),
            integer(args.get("max_files"), 5_000, 1, 50_000),
            1,
            10_000,
        ),
        max_files: integer(args.get("max_files"), 5_000, 1, 50_000),
        max_dirs: integer(args.get("max_dirs"), 1_000, 1, 10_000),
        max_depth: integer(args.get("max_depth"), 25, 0, 100),
        elapsed_ms: integer(args.get("timeout_ms"), 5_000, 10, 30_000) as u64,
    };
    Ok(Options {
        root: super::super::list_files::normalize_root(args.get("root")),
        pattern,
        regex,
        case_sensitive,
        include,
        exclude,
        context_lines,
        max_matches: integer(args.get("max_matches"), 100, 1, 1_000),
        max_bytes_per_file: integer(args.get("max_bytes_per_file"), 262_144, 1, 1_048_576),
        max_output_bytes: integer(args.get("max_output_bytes"), 262_144, 1, 4_194_304),
        limits,
    })
}
