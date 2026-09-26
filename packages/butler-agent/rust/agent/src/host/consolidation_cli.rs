//! Existing operator consolidation command, routed to the native cycle service.

use std::{ffi::OsString, path::PathBuf, sync::Arc};

use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::{
    NativeProcessEnvironment, ResolvedInstallation, SystemIdentity,
    briefing_generation::NativeBriefingGeneration, consolidation_phase::NativeCyclePhases,
    profile_consolidation::ProfileConsolidation,
};
use crate::{
    cognition::{
        BoxStoreService, CognitionPathEnvironment, CycleService, CycleStatus,
        FeedbackBufferService, KnowHowService, LegacyMetadataIntegrityService, MemoryHealthService,
        RunCycle,
    },
    coordination::CognitionWriteCoordinator,
    operations::{CycleMetrics, MetricFiles},
};

pub struct NativeConsolidationCliResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: u8,
}

struct Options {
    data: PathBuf,
    json: bool,
    quiet: bool,
    command: String,
    run_id: Option<String>,
    resume: bool,
}

pub async fn run_native_consolidation_cli(
    installation: ResolvedInstallation,
    arguments: Vec<OsString>,
) -> NativeConsolidationCliResult {
    let parsed = match parse(&installation, arguments) {
        Ok(parsed) => parsed,
        Err(message) => {
            return failure(
                false,
                "butler cognition consolidation",
                "invalid_arguments",
                &message,
                2,
            );
        }
    };
    let host = Arc::new(SystemIdentity);
    let coordinator = match CognitionWriteCoordinator::new(host.clone()) {
        Ok(value) => Arc::new(value),
        Err(error) => {
            return failure(
                parsed.json,
                "butler cognition consolidation run --manual",
                error.code,
                &error.message,
                1,
            );
        }
    };
    let cognition_paths = CognitionPathEnvironment {
        cognition_home: std::env::var("BUTLER_COGNITION_HOME").ok(),
        memory_home: std::env::var("BUTLER_COGNITION_MEMORY_HOME").ok(),
    };
    let feedback = Arc::new(FeedbackBufferService::new(
        parsed.data.clone(),
        cognition_paths.clone(),
        coordinator.clone(),
    ));
    let box_store = Arc::new(BoxStoreService::new(
        parsed.data.clone(),
        cognition_paths.clone(),
        coordinator.clone(),
    ));
    let knowhow = Arc::new(KnowHowService::new(
        parsed.data.clone(),
        cognition_paths.clone(),
        coordinator.clone(),
    ));
    if parsed.command == "status" {
        let counts = match feedback.counts(now_ms()) {
            Ok(value) => value,
            Err(error) => {
                return failure(
                    parsed.json,
                    "butler cognition consolidation status",
                    error.code,
                    error.code,
                    1,
                );
            }
        };
        let box_items = match box_store.count_indexed().await {
            Ok(value) => value,
            Err(error) => {
                return failure(
                    parsed.json,
                    "butler cognition consolidation status",
                    error.code,
                    error.code,
                    1,
                );
            }
        };
        // The operator status command counts its default first 100 indexed Box rows.
        let box_items = box_items.min(100);
        let knowhow_count = match knowhow.count_entries().await {
            Ok(value) => value,
            Err(error) => {
                return failure(
                    parsed.json,
                    "butler cognition consolidation status",
                    error.code,
                    error.code,
                    1,
                );
            }
        };
        let data = json!({
            "feedbackCount":counts.total_count,
            "activeFeedbackCount":counts.status_active_count,
            "knowhowCount":knowhow_count,"boxItems":box_items,
            "unavailable":[],
        });
        return success(
            &parsed,
            "butler cognition consolidation status",
            data,
            &format!(
                "feedback={} active={}\nknowhow={}\nboxItems={}",
                counts.total_count, counts.status_active_count, knowhow_count, box_items
            ),
        );
    }
    let metrics = Arc::new(CycleMetrics::new(Arc::new(MetricFiles::new(
        parsed.data.clone(),
    ))));
    let user_home = user_home();
    let os = match nix::sys::utsname::uname() {
        Ok(value) => value,
        Err(error) => {
            return failure(
                parsed.json,
                "butler cognition consolidation run --manual",
                "native_environment_unavailable",
                &error.to_string(),
                1,
            );
        }
    };
    let environment = NativeProcessEnvironment::capture(
        &parsed.data,
        &user_home,
        &os.release().to_string_lossy(),
    );
    let cognition_paths = environment.cognition_paths.clone();
    let briefing = match NativeBriefingGeneration::open(
        parsed.data.clone(),
        installation.resources().to_path_buf(),
        environment,
    ) {
        Ok(value) => Arc::new(value),
        Err(error) => {
            return failure(
                parsed.json,
                "butler cognition consolidation run --manual",
                &error.code,
                &error.message,
                1,
            );
        }
    };
    let phases = Arc::new(NativeCyclePhases {
        metrics: metrics.clone(),
        briefing: briefing.clone(),
        profile: Arc::new(ProfileConsolidation {
            profile: briefing.profile(),
            feedback: feedback.clone(),
        }),
        legacy_metadata: Arc::new(LegacyMetadataIntegrityService::new(
            parsed.data.clone(),
            cognition_paths.clone(),
            box_store.clone(),
            feedback.clone(),
        )),
        feedback,
        knowhow,
        health: Arc::new(MemoryHealthService::new(
            parsed.data.clone(),
            cognition_paths.clone(),
            coordinator.clone(),
        )),
        box_store,
    });
    let service = CycleService::new(
        parsed.data.clone(),
        cognition_paths,
        coordinator,
        host,
        phases,
        metrics,
    );
    let cancellation = CancellationToken::new();
    let signal_task = match start_signal_cancellation(cancellation.clone()) {
        Ok(task) => task,
        Err(error) => {
            briefing.close().await;
            return failure(
                parsed.json,
                "butler cognition consolidation run --manual",
                "native_signal_unavailable",
                &error,
                1,
            );
        }
    };
    let result = service
        .run(RunCycle {
            run_id: parsed.run_id.clone(),
            resume: parsed.resume,
            cancellation,
            ..RunCycle::default()
        })
        .await;
    signal_task.abort();
    let _ = signal_task.await;
    briefing.close().await;
    match result {
        Ok(value) => {
            let command = "butler cognition consolidation run --manual";
            let status = serde_json::to_value(value.status).unwrap_or(Value::Null);
            let data = serde_json::to_value(&value).unwrap_or(Value::Null);
            let human = format!(
                "Consolidation cycle {}: phases={}",
                status.as_str().unwrap_or("unknown"),
                value.phases.len()
            );
            if value.status == CycleStatus::Completed {
                success(&parsed, command, data, &human)
            } else {
                incomplete(&parsed, command, data, &human)
            }
        }
        Err(error) => failure(
            parsed.json,
            "butler cognition consolidation run --manual",
            error.code,
            &error.message,
            1,
        ),
    }
}

fn start_signal_cancellation(
    cancellation: CancellationToken,
) -> Result<tokio::task::JoinHandle<()>, String> {
    use tokio::signal::unix::{SignalKind, signal};
    let mut interrupt = signal(SignalKind::interrupt()).map_err(|error| error.to_string())?;
    let mut terminate = signal(SignalKind::terminate()).map_err(|error| error.to_string())?;
    Ok(tokio::spawn(async move {
        tokio::select! {
            _ = interrupt.recv() => {},
            _ = terminate.recv() => {},
        }
        cancellation.cancel();
    }))
}

fn parse(installation: &ResolvedInstallation, arguments: Vec<OsString>) -> Result<Options, String> {
    let args: Vec<String> = arguments
        .into_iter()
        .map(|value| {
            value
                .into_string()
                .map_err(|_| "arguments must be UTF-8".to_owned())
        })
        .collect::<Result<_, _>>()?;
    let mut data = None;
    let mut json = false;
    let mut quiet = false;
    let mut run_id = None;
    let mut resume = false;
    let mut manual = false;
    let mut positional = Vec::new();
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--data" | "--run-id" => {
                let name = args[index].as_str();
                let value = args
                    .get(index + 1)
                    .filter(|value| !value.starts_with("--"))
                    .ok_or_else(|| format!("{name} requires a value"))?;
                if name == "--data" {
                    data = Some(value.to_owned());
                } else {
                    run_id = Some(value.to_owned());
                }
                index += 2;
                continue;
            }
            "--json" => json = true,
            "--quiet" | "--silent" => quiet = true,
            "--manual" => manual = true,
            "--resume" => resume = true,
            "--home" => {
                return Err("--home cannot override immutable installation resources".into());
            }
            value if value.starts_with("--") => return Err(format!("unknown option: {value}")),
            value => positional.push(value.to_owned()),
        }
        index += 1;
    }
    if positional.first().map(String::as_str) != Some("cognition")
        || positional.get(1).map(String::as_str) != Some("consolidation")
    {
        return Err("expected cognition consolidation".into());
    }
    let command = positional.get(2).map(String::as_str).unwrap_or("status");
    if positional.len() > 3
        || !matches!(command, "status" | "run")
        || (command == "run" && !manual)
        || (command == "status" && (manual || resume || run_id.is_some()))
    {
        return Err("expected consolidation status or run --manual".into());
    }
    let requested = data
        .as_deref()
        .map(expand_home)
        .or_else(|| {
            std::env::var("BUTLER_DATA")
                .ok()
                .filter(|value| !value.is_empty())
                .map(|value| expand_home(&value))
        })
        .unwrap_or_else(|| user_home().join(".butler"));
    let data = installation.validate_data_root(&requested)?;
    Ok(Options {
        data,
        json,
        quiet,
        command: command.into(),
        run_id,
        resume,
    })
}

fn user_home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default()
}

fn now_ms() -> i64 {
    chrono::DateTime::<chrono::Utc>::from(std::time::SystemTime::now()).timestamp_millis()
}
fn expand_home(value: &str) -> PathBuf {
    if value == "~" {
        return user_home();
    }
    value
        .strip_prefix("~/")
        .map(|tail| user_home().join(tail))
        .unwrap_or_else(|| PathBuf::from(value))
}

fn success(
    options: &Options,
    command: &str,
    data: Value,
    human: &str,
) -> NativeConsolidationCliResult {
    NativeConsolidationCliResult {
        stdout: if options.json {
            envelope(true, command, data, None)
        } else if options.quiet {
            String::new()
        } else {
            format!("{human}\n")
        },
        stderr: String::new(),
        exit_code: 0,
    }
}

fn incomplete(
    options: &Options,
    command: &str,
    data: Value,
    human: &str,
) -> NativeConsolidationCliResult {
    NativeConsolidationCliResult {
        stdout: if options.json {
            envelope(
                false,
                command,
                data,
                Some(
                    json!({"code":"consolidation_incomplete","message":"Consolidation has unfinished phases"}),
                ),
            )
        } else if options.quiet {
            String::new()
        } else {
            format!("{human}\n")
        },
        stderr: if options.json {
            String::new()
        } else {
            "Consolidation has unfinished phases\n".into()
        },
        exit_code: 1,
    }
}

fn failure(
    json: bool,
    command: &str,
    code: &str,
    message: &str,
    exit_code: u8,
) -> NativeConsolidationCliResult {
    NativeConsolidationCliResult {
        stdout: if json {
            envelope(
                false,
                command,
                Value::Null,
                Some(json!({"code":code,"message":message})),
            )
        } else {
            String::new()
        },
        stderr: if json {
            String::new()
        } else {
            format!("{message}\n")
        },
        exit_code,
    }
}

fn envelope(ok: bool, command: &str, data: Value, error: Option<Value>) -> String {
    format!(
        "{}\n",
        serde_json::to_string_pretty(&json!({"ok":ok,"command":command,"data":data,
        "error":error,"privacy":{"rawTextIncluded":false,"secretsIncluded":false}}))
        .unwrap()
    )
}
