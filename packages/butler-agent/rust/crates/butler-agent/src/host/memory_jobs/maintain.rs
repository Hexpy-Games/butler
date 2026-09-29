//! Existing operator memory-maintain CLI over the configured Cognition cycle.

use butler_memory::cognition::CognitionCode;
use std::{ffi::OsString, path::PathBuf, sync::Arc};

use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use butler_core::configuration::ConfigurationWrites;
use butler_core::locale::LocaleCollation;
use butler_memory::cognition::{
    CognitionPathEnvironment, CognitionRegistrationService, ConfiguredCycleOptions,
    ConfiguredCycleResult, ConfiguredCycleService, GenerationVectorAdapter,
    GraphConsolidationService, LegacyIndexService, MemoryHealthReport, MemoryHealthService,
    MemorySyncConsumer, ProjectCapsuleService, VectorOptimizeService,
    active_memory_descriptor_exists, resolve_active_generation,
};
use butler_memory::coordination::CognitionWriteCoordinator;
use butler_models::models::ModelConfigurationClock;

use crate::host::cli::consolidation::ConsolidationCliResult;
use crate::host::memory_jobs::maintain_phase::ConfiguredPhases;
use crate::host::{
    EmbeddingOwner, ProcessEnvironment, ProcessModels, ResolvedInstallation, SystemIdentity,
};

struct Options {
    data: PathBuf,
    json: bool,
    quiet: bool,
    backfill_only: bool,
    command: String,
}

pub(crate) async fn run(
    installation: ResolvedInstallation,
    arguments: Vec<OsString>,
) -> ConsolidationCliResult {
    let requested_json = arguments.iter().any(|argument| argument == "--json");
    let options = match parse(&installation, arguments) {
        Ok(value) => value,
        Err(error) => return fail(requested_json, "invalid_arguments", error.message(), 2),
    };
    let paths = CognitionPathEnvironment {
        cognition_home: std::env::var("BUTLER_COGNITION_HOME").ok(),
        memory_home: std::env::var("BUTLER_COGNITION_MEMORY_HOME").ok(),
    };
    let coordinator = match CognitionWriteCoordinator::new(Arc::new(SystemIdentity)) {
        Ok(value) => Arc::new(value),
        Err(error) => return fail(options.json, error.code(), &error.message(), 1),
    };
    let health = MemoryHealthService::new(options.data.clone(), paths.clone(), coordinator.clone());
    let before = match health.read().await {
        Ok(value) => value,
        Err(error) => return fail(options.json, error.code(), &error.message(), 1),
    };
    let cancellation = CancellationToken::new();
    let signal_task = match signals(cancellation.clone()) {
        Ok(value) => value,
        Err(error) => {
            return fail(
                options.json,
                "native_signal_unavailable",
                error.message(),
                1,
            );
        }
    };
    let embedding = match EmbeddingOwner::new(options.data.clone()) {
        Ok(value) => Arc::new(value),
        Err(error) => {
            signal_task.abort();
            let _ = signal_task.await;
            return fail(options.json, error.code(), &error.message(), 1);
        }
    };
    let backfill = LegacyIndexService::new(
        options.data.clone(),
        paths.clone(),
        coordinator.clone(),
        embedding.clone(),
    )
    .backfill(&cancellation)
    .await;
    let backfill = match backfill {
        Err(error) => {
            let _ = embedding.close().await;
            signal_task.abort();
            let _ = signal_task.await;
            return fail(options.json, error.code(), &error.message(), 1);
        }
        Ok(value) => value,
    };
    let config = ConfiguredCycleOptions::load(&options.data);
    let descriptor = if options.backfill_only {
        false
    } else {
        match active_memory_descriptor_exists(&options.data, &paths) {
            Ok(value) => value,
            Err(error) => {
                let _ = embedding.close().await;
                signal_task.abort();
                let _ = signal_task.await;
                return fail(options.json, error.code(), &error.message(), 1);
            }
        }
    };
    let outcome = if options.backfill_only || !config.enabled || !descriptor {
        // No provider, generation or consumer is created on the exact source skip path.
        Ok(ConfiguredCycleResult::skipped())
    } else {
        run_active(
            &options,
            &paths,
            &config,
            coordinator.clone(),
            embedding.clone(),
            &cancellation,
        )
        .await
    };
    let closed = embedding.close().await;
    signal_task.abort();
    let _ = signal_task.await;
    let outcome = match (outcome, closed) {
        (Err(error), _) | (Ok(_), Err(error)) => {
            return fail(options.json, error.code(), &error.message(), 1);
        }
        (Ok(value), Ok(())) => value,
    };
    let (after, before_view, after_view) = match read_after(&health, &before).await {
        Ok(value) => value,
        Err(error) => return fail(options.json, error.code(), &error.message(), 1),
    };
    let data = json!({
        "exitCode":outcome.exit_code,"skipped":outcome.skipped,"phasesRun":outcome.phases_run,
        "aborted":outcome.aborted,"failedPhases":&outcome.failed_phases,
        "before":before_view,"after":after_view,
        "hotCacheVectorBackfill":backfill,
        "rawTextIncluded":false,
    });
    let stderr = if outcome.failed_phases.is_empty() {
        String::new()
    } else {
        format!(
            "memory maintenance phase errors: {}\n",
            outcome.failed_phases.join(",")
        )
    };
    ConsolidationCliResult {
        stdout: if options.json {
            format!(
                "{}\n",
                json!({"ok":true,"command":options.command,"data":data})
            )
        } else if options.quiet {
            String::new()
        } else {
            format!(
                "Memory maintenance complete: status={}\n",
                after.maintenance_status.as_str()
            )
        },
        stderr,
        exit_code: outcome.exit_code,
    }
}

async fn run_active(
    options: &Options,
    paths: &CognitionPathEnvironment,
    config: &ConfiguredCycleOptions,
    coordinator: Arc<CognitionWriteCoordinator>,
    embedding: Arc<EmbeddingOwner>,
    cancellation: &CancellationToken,
) -> butler_memory::cognition::CognitionResult<butler_memory::cognition::ConfiguredCycleResult> {
    let generation = resolve_active_generation(&options.data, paths)?;
    let os = butler_platform::instance::os_release()
        .map_err(|source| error(CognitionCode::EnvironmentUnavailable).with_source(source))?;
    let home = butler_platform::user_dirs::home_dir().unwrap_or_default();
    let environment = ProcessEnvironment::capture(&options.data, &home, &os);
    let collation = Arc::new(
        LocaleCollation::new("en-US")
            .map_err(|source| error(CognitionCode::LocaleUnavailable).with_source(source))?,
    );
    let models = ProcessModels::new(
        options.data.clone(),
        environment.model,
        Arc::new(ConfigurationWrites::new()),
        collation,
    )
    .map_err(|error| {
        butler_memory::cognition::CognitionError::new(CognitionCode::ModelSetupFailed, error.code())
    })?;
    let clock: Arc<dyn Fn() -> String + Send + Sync> = Arc::new(|| SystemIdentity.now_iso());
    let vectors = Arc::new(GenerationVectorAdapter::new(
        options.data.clone(),
        paths.clone(),
        embedding.clone(),
    ));
    let registration = Arc::new(CognitionRegistrationService::with_projection(
        paths.clone(),
        coordinator.clone(),
        clock.clone(),
        models.provider.clone(),
        vectors,
        Arc::new(SystemIdentity),
    ));
    let consumer = Arc::new(
        MemorySyncConsumer::new(
            options.data.clone(),
            paths.clone(),
            registration.clone(),
            coordinator.clone(),
            clock,
        )
        .with_embedding(embedding),
    );
    let capsules = Arc::new(ProjectCapsuleService::new(
        options.data.clone(),
        paths.clone(),
        coordinator.clone(),
    ));
    let phases = Arc::new(ConfiguredPhases {
        consumer: consumer.clone(),
        consolidate: GraphConsolidationService::new(
            options.data.clone(),
            paths.clone(),
            coordinator.clone(),
        ),
        optimize: VectorOptimizeService::new(
            options.data.clone(),
            paths.clone(),
            coordinator.clone(),
        ),
        capsules,
        health: MemoryHealthService::new(options.data.clone(), paths.clone(), coordinator),
        generation_id: generation.generation_id,
        activation_decay_d: config.activation_decay_d,
        project_capsule_refresh_limit: config.project_capsule_refresh_limit,
    });
    let service = ConfiguredCycleService::new(options.data.clone(), paths.clone(), phases);
    let result = service.run(config, cancellation).await;
    consumer.close().await;
    registration.close().await;
    result
}

/// The health after maintenance, with the views before and after it.
async fn read_after(
    health: &MemoryHealthService,
    before: &MemoryHealthReport,
) -> Result<(MemoryHealthReport, Value, Value), butler_memory::cognition::CognitionError> {
    let after = health.read().await?;
    let views = (projection(before)?, projection(&after)?);
    Ok((after, views.0, views.1))
}

fn projection(
    report: &MemoryHealthReport,
) -> Result<Value, butler_memory::cognition::CognitionError> {
    let dimensions = report.metric_dimensions()?;
    Ok(
        json!({"maintenanceStatus":report.maintenance_status.as_str(),"queueBacklog":dimensions["queue_backlog_count"],"graphEntityCount":dimensions["graph_entities_count"],"graphEdgeCount":dimensions["graph_edges_count"]}),
    )
}

fn parse(
    installation: &ResolvedInstallation,
    arguments: Vec<OsString>,
) -> Result<Options, crate::host::HostError> {
    let args: Vec<String> = arguments
        .into_iter()
        .map(|item| {
            item.into_string()
                .map_err(|_| "arguments must be UTF-8".to_owned())
        })
        .collect::<Result<_, _>>()?;
    let mut data = None;
    let mut json = false;
    let mut quiet = false;
    let mut backfill_only = false;
    let mut positional = Vec::new();
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--data" => {
                data = Some(
                    args.get(index + 1)
                        .filter(|value| !value.starts_with("--"))
                        .ok_or("--data requires a value")?
                        .clone(),
                );
                index += 2;
                continue;
            }
            "--json" => json = true,
            "--quiet" | "--silent" => quiet = true,
            "--verbose" | "--yes" | "--non-interactive" => {}
            "--hot-cache-backfill-only" => backfill_only = true,
            "--home" => {
                return Err("--home cannot override immutable installation resources".into());
            }
            value if value.starts_with("--") => {
                return Err(format!("unknown option: {value}").into());
            }
            value => positional.push(value.to_owned()),
        }
        index += 1;
    }
    if positional.len() != 3
        || !matches!(positional[0].as_str(), "cognition" | "cog")
        || positional[1] != "memory"
        || positional[2] != "maintain"
    {
        return Err("expected cognition memory maintain".into());
    }
    let requested = data
        .map(|value| expand_home(&value))
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
        backfill_only,
        command: format!("butler {} memory maintain", positional[0]),
    })
}

fn user_home() -> PathBuf {
    butler_platform::user_dirs::home_dir().unwrap_or_default()
}
fn expand_home(value: &str) -> PathBuf {
    if value == "~" {
        user_home()
    } else if let Some(tail) = value.strip_prefix("~/") {
        user_home().join(tail)
    } else {
        PathBuf::from(value)
    }
}
fn error(code: CognitionCode) -> butler_memory::cognition::CognitionError {
    butler_memory::cognition::CognitionError::new(code, code.as_str())
}
fn fail(json_mode: bool, code: &str, message: &str, exit_code: u8) -> ConsolidationCliResult {
    ConsolidationCliResult {
        stdout: if json_mode {
            format!(
                "{}\n",
                json!({"ok":false,"command":"butler cognition memory maintain","error":{"code":code,"message":message}})
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

pub(in crate::host) fn signals(
    token: CancellationToken,
) -> Result<tokio::task::JoinHandle<()>, crate::host::HostError> {
    let mut requests = butler_platform::process_control::shutdown_requests()
        .map_err(crate::host::HostError::from_error)?;
    Ok(tokio::spawn(async move {
        requests.recv().await;
        token.cancel();
    }))
}
