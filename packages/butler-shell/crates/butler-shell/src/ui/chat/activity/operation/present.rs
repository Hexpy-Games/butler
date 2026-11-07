//! `operationOutputPresentation.ts`: how an operation's stored output is shown.
use butler_ds::ui::context::Lang;
use serde_json::{Map, Value};

use super::{read, structured};
use crate::ui::chat::activity::tools::copy::{self, text};

pub(super) struct Section {
    pub(super) title: String,
    pub(super) content: Option<String>,
    pub(super) message: Option<String>,
}

pub(super) enum Presentation {
    Code(String),
    Summary(String),
    Command {
        summary: String,
        command: Option<String>,
        content: Option<String>,
    },
    Sections {
        summary: String,
        sections: Vec<Section>,
    },
}

/// JS truthiness of a JSON value.
pub(super) fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0. && !n.is_nan()),
        Some(Value::String(string)) => !string.is_empty(),
        Some(_) => true,
    }
}

/// `record(value)`: the value when it is a plain object.
pub(super) fn record(value: Option<&Value>) -> Option<&Map<String, Value>> {
    value.and_then(Value::as_object)
}

/// `text(value)`: the string, or empty.
pub(super) fn string(value: Option<&Value>) -> &str {
    value.and_then(Value::as_str).unwrap_or("")
}

/// `value[key] === true` / `=== false`.
pub(super) fn flag(value: &Map<String, Value>, key: &str, expected: bool) -> bool {
    value.get(key) == Some(&Value::Bool(expected))
}

/// A JS number printed as JS prints it (integers without a fraction).
pub(super) fn number_text(number: f64) -> String {
    format!("{number}")
}

/// presentOperationOutput
pub(super) fn present(
    tool: Option<&str>,
    content: &str,
    complete: bool,
    lang: Lang,
) -> Presentation {
    if !complete {
        return Presentation::Summary(text(lang, "st.partialOutput").to_owned());
    }
    let Some(value) = serde_json::from_str::<Value>(content)
        .ok()
        .and_then(|parsed| match parsed {
            Value::Object(map) => Some(map),
            _ => None,
        })
    else {
        return Presentation::Code(content.to_owned());
    };
    if tool == Some("run_command") {
        return command_output(&value, lang);
    }
    if let Some(output) = read::present(tool, &value, lang) {
        return output;
    }
    let pending = flag(&value, "pending", true) || flag(&value, "authority_pending", true);
    if (flag(&value, "ok", false) || pending)
        && let Some(failure) = structured::present(&value, lang)
    {
        return failure;
    }
    if let Some(tool @ ("edit_file" | "write_file" | "read_file")) = tool {
        return basic_file_output(tool, &value, lang);
    }
    if let Some(output) = structured::present(&value, lang) {
        return output;
    }
    if let Some(Value::Bool(ok)) = value.get("ok") {
        let key = if *ok {
            "st.noDetailSupport"
        } else {
            "st.operationFailed"
        };
        return Presentation::Summary(text(lang, key).to_owned());
    }
    Presentation::Summary(text(lang, "st.resultChecked").to_owned())
}

fn trimmed<'a>(value: &'a Map<String, Value>, key: &str) -> &'a str {
    string(value.get(key)).trim()
}

fn command_output(value: &Map<String, Value>, lang: Lang) -> Presentation {
    let timed_out = flag(value, "timed_out", true);
    let exit = value.get("exit_code").and_then(Value::as_f64);
    let succeeded = flag(value, "ok", true) && !timed_out && exit.is_none_or(|code| code == 0.);
    let summary = if timed_out {
        text(lang, "st.commandTimeout").to_owned()
    } else {
        let head = text(
            lang,
            if succeeded {
                "st.commandDone"
            } else {
                "st.commandFailed"
            },
        );
        match exit {
            None => head.to_owned(),
            Some(code) => format!("{head} · {}", copy::exit_code(lang, &number_text(code))),
        }
    };
    let (stdout, stderr) = (trimmed(value, "stdout"), trimmed(value, "stderr"));
    let output = if !stdout.is_empty() && !stderr.is_empty() {
        copy::command_streams(lang, stdout, stderr)
    } else if stdout.is_empty() {
        stderr.to_owned()
    } else {
        stdout.to_owned()
    };
    Presentation::Command {
        summary,
        command: value
            .get("command")
            .and_then(Value::as_str)
            .map(str::to_owned),
        content: (!output.is_empty()).then_some(output),
    }
}

fn file_name(value: Option<&Value>) -> String {
    string(value)
        .replace('\\', "/")
        .split('/')
        .rfind(|part| !part.is_empty())
        .unwrap_or("")
        .to_owned()
}

fn basic_file_output(tool: &str, value: &Map<String, Value>, lang: Lang) -> Presentation {
    if !flag(value, "ok", true) {
        return Presentation::Summary(text(lang, "st.fileFailed").to_owned());
    }
    if tool == "read_file"
        && let Some(content) = value.get("content").and_then(Value::as_str)
    {
        return Presentation::Code(content.to_owned());
    }
    let name = file_name(value.get("path"));
    if name.is_empty() {
        return Presentation::Summary(text(lang, "st.fileDone").to_owned());
    }
    let action = text(
        lang,
        if tool == "edit_file" {
            "st.editDone"
        } else {
            "st.writeDone"
        },
    );
    let size = value
        .get("bytes")
        .and_then(Value::as_u64)
        .map(|bytes| format!(" · {}", copy::bytes(lang, bytes)))
        .unwrap_or_default();
    Presentation::Summary(format!("{action} · {name}{size}"))
}
