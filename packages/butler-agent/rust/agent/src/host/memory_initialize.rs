//! Explicit empty-root memory initialization; service startup never invokes this.

use std::{ffi::OsString, path::PathBuf, sync::Arc};

use serde_json::json;

use crate::{
    cognition::{CognitionPathEnvironment, initialize_empty_memory_generation},
    coordination::CognitionWriteCoordinator,
    locale::LocaleCollation,
    models::ModelConfigurationClock,
};

use super::{
    ResolvedInstallation, SystemIdentity, consolidation_cli::NativeConsolidationCliResult,
};

pub async fn run(
    installation: ResolvedInstallation,
    arguments: Vec<OsString>,
) -> NativeConsolidationCliResult {
    let json_mode = arguments.iter().any(|item| item == "--json");
    let data = match parse(&installation, &arguments) {
        Ok(path) => path,
        Err(message) => return failure(json_mode, "invalid_arguments", &message, 2),
    };
    let coordinator = match CognitionWriteCoordinator::new(Arc::new(SystemIdentity)) {
        Ok(value) => Arc::new(value),
        Err(error) => return failure(json_mode, error.code(), &error.message(), 1),
    };
    let paths = CognitionPathEnvironment {
        cognition_home: std::env::var("BUTLER_COGNITION_HOME").ok(),
        memory_home: std::env::var("BUTLER_COGNITION_MEMORY_HOME").ok(),
    };
    let (major, minor, patch) = unicode_segmentation::UNICODE_VERSION;
    let result = initialize_empty_memory_generation(
        data,
        paths,
        coordinator,
        Arc::new(|| SystemIdentity.now_iso()),
        format!("{major}.{minor}.{patch}"),
        LocaleCollation::implementation_version().to_owned(),
    )
    .await;
    match result {
        Ok(handle) => NativeConsolidationCliResult {
            stdout: if json_mode {
                format!(
                    "{}\n",
                    json!({"ok":true,"command":"butler cognition memory rebuild initialize-empty","generation_id":handle.generation_id})
                )
            } else {
                format!(
                    "Initialized empty memory generation {}\n",
                    handle.generation_id
                )
            },
            stderr: String::new(),
            exit_code: 0,
        },
        Err(error) => failure(json_mode, error.code, &error.message, 1),
    }
}

fn parse(installation: &ResolvedInstallation, arguments: &[OsString]) -> Result<PathBuf, String> {
    let mut data = None;
    let mut positional = Vec::new();
    let mut index = 0;
    while index < arguments.len() {
        let argument = arguments[index].to_string_lossy();
        match argument.as_ref() {
            "--data" => {
                index += 1;
                data = Some(PathBuf::from(
                    arguments.get(index).ok_or("--data requires a path")?,
                ));
            }
            "--json" => {}
            value if value.starts_with("--") => return Err(format!("unknown option: {value}")),
            value => positional.push(value.to_owned()),
        }
        index += 1;
    }
    if positional.len() != 4
        || !matches!(positional[0].as_str(), "cognition" | "cog")
        || positional[1] != "memory"
        || positional[2] != "rebuild"
        || positional[3] != "initialize-empty"
    {
        return Err("expected cognition memory rebuild initialize-empty".into());
    }
    let requested = data
        .or_else(|| std::env::var_os("BUTLER_DATA").map(PathBuf::from))
        .unwrap_or_else(|| {
            std::env::var_os("HOME")
                .map(PathBuf::from)
                .unwrap_or_default()
                .join(".butler")
        });
    installation.validate_data_root(&requested)
}

fn failure(
    json_mode: bool,
    code: &str,
    message: &str,
    exit_code: u8,
) -> NativeConsolidationCliResult {
    NativeConsolidationCliResult {
        stdout: if json_mode {
            format!(
                "{}\n",
                json!({"ok":false,"command":"butler cognition memory rebuild initialize-empty","error":{"code":code,"message":message}})
            )
        } else {
            String::new()
        },
        stderr: if json_mode {
            String::new()
        } else {
            format!("{message}\n")
        },
        exit_code,
    }
}
