use serde_json::json;

use super::Options;

pub struct NativeSkillCliResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: u8,
}

pub(super) struct CommandError {
    pub(super) code: String,
    pub(super) message: String,
    pub(super) exit_code: u8,
    pub(super) data: Option<Box<serde_json::Value>>,
}

pub(super) fn failure(
    code: impl Into<String>,
    message: impl Into<String>,
    exit_code: u8,
) -> CommandError {
    CommandError {
        code: code.into(),
        message: message.into(),
        exit_code,
        data: None,
    }
}

pub(super) fn render_success(
    options: &Options,
    command: &str,
    data: serde_json::Value,
    human: String,
) -> NativeSkillCliResult {
    let stdout = if options.json {
        envelope(true, command, Some(data), None)
    } else if options.quiet {
        String::new()
    } else {
        format!("{}\n", human.trim_end())
    };
    NativeSkillCliResult {
        stdout,
        stderr: String::new(),
        exit_code: 0,
    }
}

pub(super) fn render_error(
    json_output: bool,
    command: &str,
    error: CommandError,
) -> NativeSkillCliResult {
    if json_output {
        NativeSkillCliResult {
            stdout: envelope(
                false,
                command,
                error.data.map(|value| *value),
                Some(json!({ "code": error.code, "message": error.message })),
            ),
            stderr: String::new(),
            exit_code: error.exit_code,
        }
    } else {
        NativeSkillCliResult {
            stdout: String::new(),
            stderr: format!("{}\n", error.message),
            exit_code: error.exit_code,
        }
    }
}

fn envelope(
    ok: bool,
    command: &str,
    data: Option<serde_json::Value>,
    error: Option<serde_json::Value>,
) -> String {
    format!(
        "{}\n",
        crate::json::pretty(&json!({
            "ok": ok,
            "command": command,
            "data": data.unwrap_or(serde_json::Value::Null),
            "error": error,
            "privacy": { "rawTextIncluded": false, "secretsIncluded": false }
        }))
    )
}
