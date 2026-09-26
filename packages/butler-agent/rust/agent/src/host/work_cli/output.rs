use serde_json::{Value, json};

pub struct NativeWorkCliResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: u8,
}

pub(super) struct CommandError {
    pub code: String,
    pub message: String,
    pub exit_code: u8,
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
    }
}

pub(super) fn render_success(
    json_output: bool,
    command: String,
    data: Value,
    human: String,
    quiet: bool,
) -> NativeWorkCliResult {
    let stdout = if json_output {
        envelope(true, &command, Some(data), None)
    } else if quiet {
        String::new()
    } else {
        format!("{}\n", human.trim_end())
    };
    NativeWorkCliResult {
        stdout,
        stderr: String::new(),
        exit_code: 0,
    }
}

pub(super) fn render_error(
    json_output: bool,
    command: &str,
    error: CommandError,
) -> NativeWorkCliResult {
    if json_output {
        NativeWorkCliResult {
            stdout: envelope(
                false,
                command,
                None,
                Some(json!({ "code": error.code, "message": error.message })),
            ),
            stderr: String::new(),
            exit_code: error.exit_code,
        }
    } else {
        NativeWorkCliResult {
            stdout: String::new(),
            stderr: format!("{}\n", error.message),
            exit_code: error.exit_code,
        }
    }
}

fn envelope(ok: bool, command: &str, data: Option<Value>, error: Option<Value>) -> String {
    format!(
        "{}\n",
        serde_json::to_string_pretty(&json!({
            "ok": ok,
            "command": command,
            "data": data.unwrap_or(Value::Null),
            "error": error,
            "privacy": { "rawTextIncluded": false, "secretsIncluded": false }
        }))
        .expect("JSON envelope serialization cannot fail")
    )
}
