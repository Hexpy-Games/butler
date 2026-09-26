//! One-shot native Cognition operator commands backed by domain owners.

use std::{ffi::OsString, path::PathBuf, process::ExitCode, sync::Arc};

use serde_json::{Value, json};

use super::{ResolvedInstallation, SystemIdentity, settings_cli};
use crate::{
    cognition::{
        BoxStoreService, CognitionPathEnvironment, CompletionPublisher, KnowHowService,
        MemoryHealthService, ProjectCapsuleService,
    },
    coordination::CognitionWriteCoordinator,
    operations::{CycleMetrics, MetricFiles},
};

#[path = "cognition_operator_cli/box.rs"]
mod box_cli;
#[path = "cognition_operator_cli/feedback.rs"]
mod feedback;
#[path = "cognition_operator_cli/ingest.rs"]
mod ingest;
#[path = "cognition_operator_cli/knowhow.rs"]
mod knowhow;
#[path = "cognition_operator_cli/metadata.rs"]
mod metadata;
#[path = "cognition_operator_cli/migration.rs"]
mod migration;
#[path = "cognition_operator_cli/parser.rs"]
mod parser;
#[path = "cognition_operator_cli/recall.rs"]
mod recall;
#[path = "cognition_operator_cli/recovery.rs"]
mod recovery;

#[expect(
    clippy::struct_excessive_bools,
    reason = "independent command-line flags"
)]
#[derive(Default)]
struct Options {
    data: Option<PathBuf>,
    json: bool,
    quiet: bool,
    status: bool,
    dry_run: bool,
    apply: bool,
    yes: bool,
    non_interactive: bool,
    session: Option<String>,
    positionals: Vec<String>,
    operator_args: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Command {
    MemoryStatus,
    MemoryRecall,
    MemoryIngest,
    MemoryRecovery,
    ProjectInspect,
    MetadataInspect,
    MetadataRepairLinks,
    MetadataCheck,
    Migration,
    Feedback,
    Box,
    KnowHow,
}

impl Command {
    fn name(self, prefix: &str) -> String {
        match self {
            Self::MemoryStatus => format!("butler {prefix} memory status"),
            Self::MemoryRecall => format!("butler {prefix} memory recall"),
            Self::MemoryIngest => format!("butler {prefix} memory ingest"),
            Self::MemoryRecovery => format!("butler {prefix} memory recovery"),
            Self::ProjectInspect => format!("butler {prefix} memory project inspect"),
            Self::MetadataInspect => format!("butler {prefix} memory metadata inspect"),
            Self::MetadataRepairLinks => format!("butler {prefix} memory metadata repair-links"),
            Self::MetadataCheck => format!("butler {prefix} memory metadata check"),
            Self::Migration => format!("butler {prefix} migrate"),
            Self::Feedback => format!("butler {prefix} feedback"),
            Self::Box => format!("butler {prefix} box"),
            Self::KnowHow => format!("butler {prefix} know-how"),
        }
    }
}

struct CliError {
    code: String,
    message: String,
    exit: u8,
}

impl CliError {
    fn invalid(message: impl Into<String>) -> Self {
        Self {
            code: "invalid_arguments".into(),
            message: message.into(),
            exit: 2,
        }
    }

    fn failed(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            exit: 1,
        }
    }
}

pub fn recognizes(args: &[OsString]) -> bool {
    let values = parser::positionals_without_options(args);
    let Some((command, _, _)) = parser::command_prefix(&values) else {
        return false;
    };
    match command {
        Command::Feedback => feedback::recognizes(args),
        _ => true,
    }
}

pub async fn run(installation: ResolvedInstallation, args: Vec<OsString>) -> ExitCode {
    let (options, command, prefix) = match parser::parse(&args) {
        Ok(parsed) => parsed,
        Err((name, error, json_requested)) => {
            return report_error(&name, json_requested, &error);
        }
    };
    let command_name = match command {
        Command::Migration if options.apply => format!("butler {prefix} migrate --apply"),
        Command::Migration if options.status => format!("butler {prefix} migrate --status"),
        Command::Box => box_cli::command_name(&prefix, &options.operator_args),
        Command::KnowHow => knowhow::command_name(&prefix, &options.operator_args),
        Command::MemoryRecall => recall::command_name(&prefix),
        Command::MemoryRecovery => recovery::command_name(&prefix, &options.operator_args),
        Command::Migration => format!("butler {prefix} migrate --dry-run"),
        Command::Feedback => feedback::command_name(&prefix, &options.operator_args),
        _ => command.name(&prefix),
    };
    let data_root =
        match settings_cli::resolve_data_root_override(options.data.clone(), &installation) {
            Ok(path) => path,
            Err(message) => {
                return report_error(
                    &command_name,
                    options.json,
                    &CliError::failed("butler_data_unavailable", message),
                );
            }
        };
    let paths = CognitionPathEnvironment {
        cognition_home: env_value("BUTLER_COGNITION_HOME"),
        memory_home: env_value("BUTLER_COGNITION_MEMORY_HOME"),
    };
    let coordinator = match CognitionWriteCoordinator::new(Arc::new(SystemIdentity)) {
        Ok(value) => Arc::new(value),
        Err(error) => {
            return report_error(
                &command_name,
                options.json,
                &CliError::failed(error.code(), error.message()),
            );
        }
    };

    let outcome = match command {
        Command::MemoryStatus => {
            let health =
                MemoryHealthService::new(data_root.clone(), paths.clone(), coordinator.clone());
            match health.read().await {
                Ok(report) => {
                    CycleMetrics::new(Arc::new(MetricFiles::new(data_root.clone()))).record(
                        "health",
                        report.metric_status,
                        &report.metric_dimensions.clone(),
                    );
                    let data = report.summary;
                    let human = format!(
                        "hotCacheFiles={} transcriptFiles={}\nprojectCapsules={} missing={} refreshFailures={}\nmemoryChunks={} vectorRows={} graphEntities={} graphEdges={}\nmaintenance={}",
                        display(&data["hotCacheFiles"]),
                        display(&data["transcriptFiles"]),
                        display(&data["projectCapsules"]),
                        display(&data["missingProjectCapsules"]),
                        display(&data["projectRefreshFailureCount"]),
                        display(&data["memoryChunkCount"]),
                        display(&data["vectorRowCount"]),
                        display(&data["graphEntityCount"]),
                        display(&data["graphEdgeCount"]),
                        display(&data["maintenanceStatus"]),
                    );
                    Ok((data, human))
                }
                Err(error) => Err(CliError::failed(error.code, error.message)),
            }
        }
        Command::MemoryRecall => recall::run(&data_root, &paths, &options.operator_args),
        Command::MemoryIngest => {
            ingest::run(
                data_root,
                paths,
                options.session.as_deref().unwrap_or_default(),
                options.dry_run,
                coordinator,
            )
            .await
        }
        Command::MemoryRecovery => {
            recovery::run(
                data_root,
                paths,
                coordinator,
                &options.operator_args,
                options.yes,
                options.non_interactive,
                installation.root(),
            )
            .await
        }
        Command::ProjectInspect => {
            let project_id = options.positionals.get(4).map(String::as_str).unwrap_or("");
            let service =
                ProjectCapsuleService::new(data_root.clone(), paths.clone(), coordinator.clone());
            match service.inspect(project_id).await {
                Ok(report) => {
                    let human = format!(
                        "project={} exists={} bytes={}\nupdated={}\nsections={}\nrefreshFailures={}{}",
                        report.project_id,
                        report.exists,
                        report.bytes,
                        report.updated_at.as_deref().unwrap_or("missing"),
                        if report.section_headings.is_empty() {
                            "none".to_owned()
                        } else {
                            report.section_headings.join(", ")
                        },
                        report.refresh_failures.count,
                        if report.diagnostics.is_empty() {
                            String::new()
                        } else {
                            format!("\ndiagnostics={}", report.diagnostics.join("; "))
                        },
                    );
                    match serde_json::to_value(&report) {
                        Ok(data) => Ok((data, human)),
                        Err(_) => Err(CliError::failed(
                            "invalid_output",
                            "Could not serialize project capsule inspection",
                        )),
                    }
                }
                Err(error) => Err(CliError::failed(error.code, error.message)),
            }
        }
        Command::MetadataInspect | Command::MetadataRepairLinks | Command::MetadataCheck => {
            metadata::run(
                command,
                data_root,
                paths,
                coordinator,
                options.positionals.get(4).map(String::as_str),
                options.yes,
                options.non_interactive,
            )
            .await
        }
        Command::Feedback => {
            feedback::run(
                data_root.clone(),
                paths.clone(),
                coordinator.clone(),
                &options.operator_args,
                options.yes,
                options.non_interactive,
                CompletionPublisher::new(
                    &data_root,
                    &paths,
                    Arc::new(|| {
                        chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
                    }),
                ),
            )
            .await
        }
        Command::Box => {
            let service =
                BoxStoreService::new(data_root.clone(), paths.clone(), coordinator.clone());
            box_cli::run(
                service,
                &options.operator_args,
                options.yes,
                options.non_interactive,
            )
            .await
        }
        Command::KnowHow => {
            let service =
                KnowHowService::new(data_root.clone(), paths.clone(), coordinator.clone());
            knowhow::run(
                service,
                data_root,
                paths,
                coordinator,
                &options.operator_args,
                options.yes,
                options.non_interactive,
            )
            .await
        }
        Command::Migration => {
            migration::run(
                data_root,
                paths,
                coordinator,
                options.status,
                options.dry_run,
                options.apply,
            )
            .await
        }
    };

    match outcome {
        Ok((data, human)) => report_success(&options, command_name.as_str(), &data, &human),
        Err(error) => report_error(command_name.as_str(), options.json, &error),
    }
}

fn env_value(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
}

fn display(value: &Value) -> String {
    match value {
        Value::Null => "unknown".to_owned(),
        Value::String(value) => value.clone(),
        Value::Number(value) => value.to_string(),
        _ => value.to_string(),
    }
}

fn report_success(options: &Options, command: &str, data: &Value, human: &str) -> ExitCode {
    if options.json {
        let raw_text_included = contains_raw_text(data);
        println!(
            "{}",
            json!({
                "ok": true,
                "command": command,
                "data": data,
                "error": null,
                "privacy": {
                    "rawTextIncluded": raw_text_included,
                    "secretsIncluded": false
                }
            })
        );
    } else if !options.quiet {
        println!("{human}");
    }
    ExitCode::SUCCESS
}

fn contains_raw_text(data: &Value) -> bool {
    data.pointer("/entry/text")
        .and_then(Value::as_str)
        .is_some()
        || data
            .pointer("/raw")
            .and_then(Value::as_array)
            .is_some_and(|items| {
                items
                    .iter()
                    .any(|item| item.get("text").and_then(Value::as_str).is_some())
            })
}

fn report_error(command: &str, json_output: bool, error: &CliError) -> ExitCode {
    if json_output {
        println!(
            "{}",
            json!({
                "ok": false,
                "command": command,
                "data": null,
                "error": { "code": error.code, "message": error.message },
                "privacy": { "rawTextIncluded": false, "secretsIncluded": false }
            })
        );
    } else {
        eprintln!("{}", error.message);
    }
    ExitCode::from(error.exit)
}
