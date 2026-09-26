//! Parsing for the existing memory rebuild operator router.

use std::{ffi::OsString, path::PathBuf};

use super::ResolvedInstallation;
use crate::cognition::ProjectionModelPolicyInput;

pub(super) enum Operation {
    Prepare,
    Inspect(String),
    Build(String),
    Validate {
        generation: String,
        acceptance: PathBuf,
    },
    Activate {
        generation: String,
        expected_active: Option<String>,
    },
    Rollback {
        generation: String,
    },
    RetryFailed {
        generation: String,
        vector_repair_input: Option<PathBuf>,
    },
    SetExtractor {
        generation: String,
        policy: ProjectionModelPolicyInput,
    },
    RepairInputs {
        generation: String,
        input: Option<PathBuf>,
        dry_run: bool,
    },
}
pub(super) struct Options {
    pub(super) data: PathBuf,
    pub(super) json: bool,
    pub(super) operation: Operation,
}

pub(super) fn parse(
    installation: &ResolvedInstallation,
    arguments: Vec<OsString>,
) -> Result<Options, String> {
    let mut data = None;
    let mut json = false;
    let mut generation = None;
    let mut acceptance = None;
    let mut expected_active = None;
    let mut vector_repair_input = None;
    let mut repair_input = None;
    let mut dry_run = false;
    let mut model = None;
    let mut effort = None;
    let mut fallback_model = None;
    let mut fallback_effort = None;
    let mut positional = Vec::new();
    let mut args = arguments.into_iter();
    while let Some(argument) = args.next() {
        let value = argument
            .into_string()
            .map_err(|_| "arguments must be UTF-8")?;
        match value.as_str() {
            "--data" => data = Some(PathBuf::from(args.next().ok_or("--data requires a path")?)),
            "--generation" => {
                generation = Some(
                    args.next()
                        .ok_or("--generation requires an ID")?
                        .into_string()
                        .map_err(|_| "generation ID must be UTF-8")?,
                );
            }
            "--acceptance" => {
                acceptance = Some(PathBuf::from(
                    args.next().ok_or("--acceptance requires a path")?,
                ));
            }
            "--expected-active" => {
                expected_active = Some(
                    args.next()
                        .ok_or("--expected-active requires an ID")?
                        .into_string()
                        .map_err(|_| "active generation ID must be UTF-8")?,
                );
            }
            "--vector-repair-input" => {
                vector_repair_input = Some(PathBuf::from(
                    args.next().ok_or("--vector-repair-input requires a path")?,
                ));
            }
            "--input" => {
                repair_input = Some(PathBuf::from(args.next().ok_or("--input requires a path")?));
            }
            "--dry-run" => dry_run = true,
            "--model" => {
                model = Some(
                    args.next()
                        .ok_or("--model requires a value")?
                        .into_string()
                        .map_err(|_| "model must be UTF-8")?,
                );
            }
            "--reasoning-effort" => {
                effort = Some(
                    args.next()
                        .ok_or("--reasoning-effort requires a value")?
                        .into_string()
                        .map_err(|_| "effort must be UTF-8")?,
                );
            }
            "--quota-fallback-model" => {
                fallback_model = Some(
                    args.next()
                        .ok_or("--quota-fallback-model requires a value")?
                        .into_string()
                        .map_err(|_| "model must be UTF-8")?,
                );
            }
            "--quota-fallback-reasoning-effort" => {
                fallback_effort = Some(
                    args.next()
                        .ok_or("--quota-fallback-reasoning-effort requires a value")?
                        .into_string()
                        .map_err(|_| "effort must be UTF-8")?,
                );
            }
            "--json" => json = true,
            value if value.starts_with("--") => return Err(format!("unknown option: {value}")),
            value => positional.push(value.to_owned()),
        }
    }
    if positional.len() != 4
        || !matches!(positional[0].as_str(), "cognition" | "cog")
        || positional[1] != "memory"
        || positional[2] != "rebuild"
    {
        return Err(
            "expected cognition memory rebuild <prepare|build|inspect|validate|activate|rollback|retry-failed|set-extractor|repair-inputs>"
                .into(),
        );
    }
    let expected_active_requested = expected_active.is_some();
    let vector_repair_requested = vector_repair_input.is_some();
    let policy_requested = model.is_some()
        || effort.is_some()
        || fallback_model.is_some()
        || fallback_effort.is_some();
    let input_requested = repair_input.is_some() || dry_run;
    let operation = match (positional[3].as_str(), generation, acceptance) {
        ("prepare", None, None) => Operation::Prepare,
        ("inspect", Some(value), None) => Operation::Inspect(value),
        ("build", Some(value), None) => Operation::Build(value),
        ("validate", Some(generation), Some(acceptance)) => Operation::Validate {
            generation,
            acceptance,
        },
        ("activate", Some(generation), None) => Operation::Activate {
            generation,
            expected_active,
        },
        ("rollback", Some(generation), None) if expected_active.is_none() => {
            Operation::Rollback { generation }
        }
        ("retry-failed", Some(generation), None) if expected_active.is_none() => {
            Operation::RetryFailed {
                generation,
                vector_repair_input,
            }
        }
        ("set-extractor", Some(generation), None) if expected_active.is_none() => {
            Operation::SetExtractor {
                generation,
                policy: ProjectionModelPolicyInput {
                    primary_model: model.unwrap_or_default(),
                    primary_effort: effort.unwrap_or_default(),
                    fallback_model: fallback_model.unwrap_or_default(),
                    fallback_effort: fallback_effort.unwrap_or_default(),
                },
            }
        }
        ("repair-inputs", Some(generation), None) if expected_active.is_none() => {
            Operation::RepairInputs {
                generation,
                input: repair_input,
                dry_run,
            }
        }
        _ => {
            return Err(
                "prepare takes no generation; build/inspect require --generation, validate also requires --acceptance".into(),
            );
        }
    };
    if expected_active_requested && !matches!(operation, Operation::Activate { .. }) {
        return Err("--expected-active is only valid for activate".into());
    }
    if vector_repair_requested && !matches!(operation, Operation::RetryFailed { .. }) {
        return Err("--vector-repair-input is only valid for retry-failed".into());
    }
    if policy_requested && !matches!(operation, Operation::SetExtractor { .. }) {
        return Err("model policy options are only valid for set-extractor".into());
    }
    if input_requested && !matches!(operation, Operation::RepairInputs { .. }) {
        return Err("--input and --dry-run are only valid for repair-inputs".into());
    }
    let requested = data
        .or_else(|| std::env::var_os("BUTLER_DATA").map(PathBuf::from))
        .unwrap_or_else(|| {
            std::env::var_os("HOME")
                .map(PathBuf::from)
                .unwrap_or_default()
                .join(".butler")
        });
    Ok(Options {
        data: installation.validate_data_root(&requested)?,
        json,
        operation,
    })
}
