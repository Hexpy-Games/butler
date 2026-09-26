use std::{
    collections::{HashMap, HashSet},
    ffi::OsString,
};

use serde_json::{Map, Value, json};

#[expect(
    clippy::struct_excessive_bools,
    reason = "independent command-line flags"
)]
#[derive(Default)]
pub(super) struct Options {
    pub(super) data: Option<String>,
    pub(super) json: bool,
    pub(super) quiet: bool,
    pub(super) yes: bool,
    pub(super) non_interactive: bool,
    pub(super) positionals: Vec<String>,
    pub(super) values: HashMap<String, Vec<String>>,
    pub(super) flags: HashSet<String>,
}

#[derive(Debug)]
pub(super) struct CliError {
    pub(super) code: &'static str,
    pub(super) message: String,
    pub(super) exit: u8,
}

impl CliError {
    pub(super) fn invalid(message: impl Into<String>) -> Self {
        Self {
            code: "invalid_arguments",
            message: message.into(),
            exit: 2,
        }
    }

    pub(super) fn failed(code: &'static str, message: impl Into<String>, exit: u8) -> Self {
        Self {
            code,
            message: message.into(),
            exit,
        }
    }
}

pub(super) fn parse(args: &[OsString]) -> Result<Options, CliError> {
    let mut options = Options::default();
    let mut index = 0;
    while index < args.len() {
        let value = args[index].to_string_lossy().into_owned();
        match value.as_str() {
            "--data" => {
                options.data = Some(take_value(args, &mut index, "--data")?);
            }
            "--home" => {
                return Err(CliError::invalid(
                    "--home is unsupported; use --data for writable state",
                ));
            }
            "--json" => options.json = true,
            "--quiet" | "--silent" => options.quiet = true,
            "--verbose" => {}
            "--yes" => options.yes = true,
            "--non-interactive" => options.non_interactive = true,
            "--disabled" => {
                options.flags.insert(value);
            }
            "--id" | "--name" | "--display-name" | "--transport" | "--command" | "--arg"
            | "--cwd" | "--url" | "--env" | "--env-ref" | "--env-file" | "--header"
            | "--header-env" | "--header-file" => {
                let item = take_value(args, &mut index, &value)?;
                options.values.entry(value).or_default().push(item);
                index += 1;
                continue;
            }
            option if option.starts_with('-') => {
                return Err(CliError::invalid(format!(
                    "unsupported MCP option: {option}"
                )));
            }
            _ => options.positionals.push(value),
        }
        index += 1;
    }
    if options
        .positionals
        .first()
        .is_none_or(|value| value != "mcp")
    {
        return Err(CliError::invalid("expected mcp command"));
    }
    Ok(options)
}

fn take_value(args: &[OsString], index: &mut usize, option: &str) -> Result<String, CliError> {
    let value = args
        .get(*index + 1)
        .filter(|value| !value.to_string_lossy().starts_with('-'))
        .filter(|value| !value.is_empty())
        .ok_or_else(|| CliError::invalid(format!("{option} requires a value")))?
        .to_string_lossy()
        .into_owned();
    *index += 1;
    Ok(value)
}

pub(super) fn value(options: &Options, key: &str) -> Option<String> {
    options
        .values
        .get(key)
        .and_then(|values| values.last())
        .cloned()
}

pub(super) fn values(options: &Options, key: &str) -> Vec<String> {
    options.values.get(key).cloned().unwrap_or_default()
}

pub(super) fn upsert_input(options: &Options, id: &str) -> Result<Value, String> {
    let transport = value(options, "--transport").unwrap_or_else(|| "stdio".into());
    if !matches!(transport.as_str(), "stdio" | "http" | "sse") {
        return Err("--transport must be stdio, http, or sse".into());
    }
    let env = secrets(
        options,
        &["--env", "--env-ref", "--env-file"],
        &["literal", "env", "file"],
    )?;
    let headers = secrets(
        options,
        &["--header", "--header-env", "--header-file"],
        &["literal", "env", "file"],
    )?;
    let mut input = Map::new();
    input.insert("id".into(), json!(id));
    input.insert(
        "enabled".into(),
        json!(!options.flags.contains("--disabled")),
    );
    input.insert("transport".into(), json!(transport));
    input.insert("args".into(), json!(values(options, "--arg")));
    input.insert("env".into(), json!(env));
    input.insert("headers".into(), json!(headers));
    for (field, option) in [
        (
            "display_name",
            value(options, "--name").or_else(|| value(options, "--display-name")),
        ),
        ("command", value(options, "--command")),
        ("cwd", value(options, "--cwd")),
        ("url", value(options, "--url")),
    ] {
        if let Some(value) = option {
            input.insert(field.into(), Value::String(value));
        }
    }
    Ok(Value::Object(input))
}

fn secrets(options: &Options, names: &[&str], sources: &[&str]) -> Result<Vec<Value>, String> {
    let mut result = Vec::new();
    for (flag, source) in names.iter().zip(sources) {
        for value in values(options, flag) {
            let Some((key, value)) = value.split_once('=') else {
                return Err("MCP secret options must use KEY=VALUE form.".into());
            };
            if key.trim().is_empty() {
                return Err("MCP secret options must use KEY=VALUE form.".into());
            }
            result.push(json!({"key": key.trim(), "source": source, "value": value.trim()}));
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;

    use super::{parse, upsert_input};

    #[test]
    fn add_omits_unset_optional_fields_but_replaces_secret_arrays() {
        let args = ["mcp", "add", "--id", "local"].map(OsString::from).to_vec();
        let options = parse(&args).unwrap();
        let input = upsert_input(&options, "local").unwrap();
        assert!(input.get("command").is_none());
        assert!(input.get("cwd").is_none());
        assert!(input.get("url").is_none());
        assert!(input.get("display_name").is_none());
        assert_eq!(input["args"], serde_json::json!([]));
        assert_eq!(input["env"], serde_json::json!([]));
        assert_eq!(input["headers"], serde_json::json!([]));
        assert_eq!(input["enabled"], true);
    }
}
