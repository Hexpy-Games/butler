use std::borrow::Cow;
use std::path::Path;

use chrono::{DateTime, Utc};
use serde::Serialize;

use super::*;
use crate::json::Utf16Slice;
use crate::public_text::trim_js_whitespace;

pub(super) fn budget(
    butler_data: &Path,
    estimator: &OwnedDefaultTokenEstimator,
    identity: &dyn ToolOutputIdentity,
    input: BudgetToolOutputInput,
) -> ContextResult<BudgetedToolOutput> {
    let requested = input.max_model_tokens.filter(|value| value.is_finite());
    let max_tokens =
        crate::json::saturating_usize(requested.unwrap_or(1_200.0).trunc().clamp(200.0, 8_000.0));
    let mode = match &input.output_mode {
        OutputModeInput::Present(serde_json::Value::String(value)) if value == "full" => "full",
        OutputModeInput::Present(serde_json::Value::String(value))
            if value == "silent_on_success" =>
        {
            "silent_on_success"
        }
        _ => "auto",
    };
    let success = input.result.exit_code == Some(0) && !input.result.timed_out;
    let validation = input
        .validation_suite
        .as_ref()
        .and_then(|value| value.as_str())
        .is_some_and(|value| !trim_js_whitespace(value).is_empty());
    let suppressed = success && (mode == "silent_on_success" || (mode == "auto" && validation));
    let failure_preview = !success && mode != "full";
    let failure_stdout = failure_preview.then(|| failure_output_preview(&input.result.stdout));
    let failure_stderr = failure_preview.then(|| failure_output_preview(&input.result.stderr));
    let changed = (suppressed
        && (!input.result.stdout.is_empty() || !input.result.stderr.is_empty()))
        || failure_stdout.as_ref().is_some_and(|value| value.1)
        || failure_stderr.as_ref().is_some_and(|value| value.1);
    let mut presentation = OutputPresentation {
        mode,
        requested_max_tokens: requested,
        applied_max_tokens: max_tokens,
        suppressed,
        truncated: changed,
    };
    let raw_tokens = estimate_output(estimator, &input.result.stdout, &input.result.stderr)?;
    if raw_tokens <= max_tokens as f64 && !changed && !input.retain_original {
        return Ok(BudgetedToolOutput {
            stdout: ExactText::Plain(input.result.stdout),
            stderr: ExactText::Plain(input.result.stderr),
            exit_code: input.result.exit_code,
            timed_out: input.result.timed_out,
            output_presentation: Some(presentation),
            butler_tool_artifact: None,
        });
    }

    let now = identity.now();
    let date: DateTime<Utc> = now.into();
    let created_at = date.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let id = format!(
        "{}_{}",
        if input
            .command
            .as_deref()
            .is_some_and(|value| !value.is_empty())
        {
            "cmd"
        } else {
            "tool"
        },
        identity.uuid().chars().take(12).collect::<String>()
    );
    let directory = butler_data
        .join("artifacts/tool-output")
        .join(&created_at[..10]);
    let path = directory.join(format!("{id}.json"));
    std::fs::create_dir_all(&directory).map_err(io_error)?;
    let artifact = StoredArtifact {
        schema: "butler.tool-output.v1",
        id: &id,
        created_at: &created_at,
        command: input.command.as_deref(),
        cwd: input.cwd.as_deref(),
        result: StoredResult {
            stdout: &input.result.stdout,
            stderr: &input.result.stderr,
            exit_code: input.result.exit_code,
            timed_out: input.result.timed_out,
        },
        raw_tokens: crate::json::saturating_u64(raw_tokens),
    };
    identity.before_artifact_write();
    std::fs::write(
        &path,
        serde_json::to_string_pretty(&artifact)
            .map_err(|error| ContextError::new("tool_output_json_error", error.to_string()))?,
    )
    .map_err(io_error)?;

    let stdout_view = if suppressed {
        View::Empty
    } else if let Some((value, _)) = &failure_stdout {
        View::Exact(value)
    } else {
        View::Raw(&input.result.stdout)
    };
    let stderr_view = if suppressed {
        View::Empty
    } else if let Some((value, _)) = &failure_stderr {
        View::Exact(value)
    } else {
        View::Raw(&input.result.stderr)
    };
    let preview_tokens = if changed {
        estimate_views(estimator, stdout_view, stderr_view)?
    } else {
        raw_tokens
    };
    let needs_fit = preview_tokens > max_tokens as f64;
    presentation.truncated |= needs_fit;
    let (stdout, stderr) = if needs_fit {
        let notice = format!(
            "[Butler compacted {} estimated tool-output tokens into a preview.]\nArtifact ID: {id}\nUse read_tool_output_artifact with search or a focused slice for omitted output.",
            comma_count(crate::json::saturating_u64(raw_tokens)),
        );
        fit_preview(estimator, stdout_view, stderr_view, &notice, max_tokens)?
    } else if suppressed {
        (
            ExactText::Plain(String::new()),
            ExactText::Plain(String::new()),
        )
    } else {
        (
            failure_stdout.map_or_else(|| ExactText::Plain(input.result.stdout), |value| value.0),
            failure_stderr.map_or_else(|| ExactText::Plain(input.result.stderr), |value| value.0),
        )
    };
    let compact_tokens = estimate_exact_output(estimator, &stdout, &stderr)?;
    Ok(BudgetedToolOutput {
        stdout,
        stderr,
        exit_code: input.result.exit_code,
        timed_out: input.result.timed_out,
        output_presentation: Some(presentation),
        butler_tool_artifact: Some(ToolOutputArtifact {
            id,
            path,
            raw_tokens,
            compact_tokens,
            created_at,
            command: input.command,
        }),
    })
}

#[derive(Serialize)]
struct StoredArtifact<'a> {
    schema: &'static str,
    id: &'a str,
    created_at: &'a str,
    command: Option<&'a str>,
    cwd: Option<&'a str>,
    result: StoredResult<'a>,
    raw_tokens: u64,
}

#[derive(Serialize)]
struct StoredResult<'a> {
    stdout: &'a str,
    stderr: &'a str,
    exit_code: Option<i32>,
    timed_out: bool,
}

#[expect(
    clippy::needless_pass_by_value,
    reason = "map_err/iterator adapter taking owned values"
)]
fn io_error(error: std::io::Error) -> ContextError {
    ContextError::new("tool_output_io_error", error.to_string())
}

pub(super) fn estimate_output(
    estimator: &OwnedDefaultTokenEstimator,
    stdout: &str,
    stderr: &str,
) -> ContextResult<f64> {
    let mut rendered = String::new();
    if !stdout.is_empty() {
        rendered.push_str("stdout:\n");
        rendered.push_str(stdout);
    }
    if !stderr.is_empty() {
        if !rendered.is_empty() {
            rendered.push_str("\n\n");
        }
        rendered.push_str("stderr:\n");
        rendered.push_str(stderr);
    }
    Ok(estimator.estimate(&rendered)?.tokens)
}

fn estimate_views(
    estimator: &OwnedDefaultTokenEstimator,
    stdout: View<'_>,
    stderr: View<'_>,
) -> ContextResult<f64> {
    let mut rendered = String::new();
    if !stdout.is_empty() {
        rendered.push_str("stdout:\n");
        rendered.push_str(&stdout.utf8_lossy());
    }
    if !stderr.is_empty() {
        if !rendered.is_empty() {
            rendered.push_str("\n\n");
        }
        rendered.push_str("stderr:\n");
        rendered.push_str(&stderr.utf8_lossy());
    }
    match estimator.provider_id() {
        "openai" => Ok(estimator.estimate(&rendered)?.tokens),
        "google" => Ok((rendered.encode_utf16().count() as f64 / 4.0).ceil()),
        _ => Ok((rendered.encode_utf16().count() as f64 / 3.8).ceil()),
    }
}

fn estimate_exact_output(
    estimator: &OwnedDefaultTokenEstimator,
    stdout: &ExactText,
    stderr: &ExactText,
) -> ContextResult<f64> {
    estimate_views(estimator, View::Exact(stdout), View::Exact(stderr))
}

#[derive(Clone, Copy)]
enum View<'a> {
    Raw(&'a str),
    Exact(&'a ExactText),
    Empty,
}

impl<'a> View<'a> {
    fn is_empty(self) -> bool {
        self.len_utf16() == 0
    }
    fn len_utf16(self) -> usize {
        match self {
            Self::Raw(text) => text.encode_utf16().count(),
            Self::Exact(text) => text.len_utf16(),
            Self::Empty => 0,
        }
    }
    fn utf8_lossy(self) -> Cow<'a, str> {
        match self {
            Self::Raw(text) => Cow::Borrowed(text),
            Self::Exact(text) => text.utf8_lossy(),
            Self::Empty => Cow::Borrowed(""),
        }
    }
    fn prefix(self, units: usize) -> ExactText {
        match self {
            Self::Raw(text) => ExactText::from_slice(&Utf16Slice::new(text, 0, units)),
            Self::Exact(ExactText::Plain(text)) => {
                ExactText::from_slice(&Utf16Slice::new(text, 0, units))
            }
            Self::Exact(ExactText::Units(value)) => {
                ExactText::Units(value[..units.min(value.len())].to_vec())
            }
            Self::Empty => ExactText::Plain(String::new()),
        }
    }
}

fn failure_output_preview(output: &str) -> (ExactText, bool) {
    let line_breaks = output.bytes().filter(|byte| *byte == b'\n').count();
    if line_breaks < 20 && output.encode_utf16().count() <= 1_000 {
        return (ExactText::Plain(output.to_owned()), false);
    }
    // Keep the last twenty lines when there are at least twenty line breaks.
    let tail = match output.rmatch_indices('\n').nth(19) {
        Some((preceding_break, _)) => output.get(preceding_break + 1..).unwrap_or(output),
        None => output,
    };
    let total = tail.encode_utf16().count();
    let mut units = "...[output truncated]\n".encode_utf16().collect::<Vec<_>>();
    units.extend(Utf16Slice::new(tail, total.saturating_sub(1_000), total).code_units());
    (ExactText::Units(units), true)
}

fn fit_preview(
    estimator: &OwnedDefaultTokenEstimator,
    stdout: View<'_>,
    stderr: View<'_>,
    notice: &str,
    max: usize,
) -> ContextResult<(ExactText, ExactText)> {
    let stderr_limit = prefix_with_budget(
        stderr.len_utf16(),
        |length| {
            let stderr_prefix = stderr.prefix(length);
            let mut stderr_text = String::new();
            if length > 0 {
                stderr_text.push_str("stderr preview:\n");
                stderr_text.push_str(&stderr_prefix.utf8_lossy());
            }
            estimate_output(estimator, notice, &stderr_text)
        },
        crate::json::saturating_usize((max as f64 * 0.45).floor()),
    )?;
    let stderr_text = if stderr_limit > 0 {
        concat_exact("stderr preview:\n", stderr.prefix(stderr_limit))
    } else {
        ExactText::Plain(String::new())
    };
    let stdout_limit = prefix_with_budget(
        stdout.len_utf16(),
        |length| {
            let stdout_prefix = stdout.prefix(length);
            let mut stdout_text = notice.to_owned();
            if length > 0 {
                stdout_text.push_str("\n\nstdout preview:\n");
                stdout_text.push_str(&stdout_prefix.utf8_lossy());
            }
            estimate_exact_output(estimator, &ExactText::Plain(stdout_text), &stderr_text)
        },
        max,
    )?;
    let stdout_text = if stdout_limit > 0 {
        concat_exact(
            &format!("{notice}\n\nstdout preview:\n"),
            stdout.prefix(stdout_limit),
        )
    } else {
        ExactText::Plain(notice.to_owned())
    };
    Ok((stdout_text, stderr_text))
}

fn prefix_with_budget(
    mut high: usize,
    mut estimate: impl FnMut(usize) -> ContextResult<f64>,
    max: usize,
) -> ContextResult<usize> {
    let mut low = 0;
    while low < high {
        let middle = low + (high - low).div_ceil(2);
        if estimate(middle)? <= max as f64 {
            low = middle;
        } else {
            high = middle - 1;
        }
    }
    Ok(low)
}

fn concat_exact(prefix: &str, suffix: ExactText) -> ExactText {
    let mut units = prefix.encode_utf16().collect::<Vec<_>>();
    match suffix {
        ExactText::Plain(text) => units.extend(text.encode_utf16()),
        ExactText::Units(value) => units.extend(value),
    }
    ExactText::Units(units)
}

fn comma_count(value: u64) -> String {
    let digits = value.to_string();
    let mut result = String::new();
    for (index, character) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            result.push(',');
        }
        result.push(character);
    }
    result
}
