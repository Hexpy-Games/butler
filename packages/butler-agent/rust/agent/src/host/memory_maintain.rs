//! Existing operator memory-maintain CLI over the configured Cognition cycle.

use std::{ffi::OsString, path::PathBuf, sync::Arc};

use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::{
    cognition::{
        CognitionPathEnvironment, CognitionRegistrationService, ConfiguredCycleOptions,
        ConfiguredCycleResult, ConfiguredCycleService, GraphConsolidationService,
        LegacyIndexService, MemoryHealthReport, MemoryHealthService, NativeGenerationVectorAdapter,
        NativeMemorySyncConsumer, NativeVectorOptimizeService, ProjectCapsuleService,
        active_memory_descriptor_exists, resolve_active_generation,
    },
    configuration::ConfigurationWrites,
    coordination::CognitionWriteCoordinator,
    locale::LocaleCollation,
    models::ModelConfigurationClock,
};

use super::{
    NativeEmbeddingOwner, NativeProcessEnvironment, NativeProcessModels, ResolvedInstallation,
    SystemIdentity, consolidation_cli::NativeConsolidationCliResult,
    memory_maintain_phase::NativeConfiguredPhases,
};

struct Options {
    data: PathBuf,
    json: bool,
    quiet: bool,
    backfill_only: bool,
    command: String,
}

pub async fn run(
    installation: ResolvedInstallation,
    arguments: Vec<OsString>,
) -> NativeConsolidationCliResult {
    let requested_json = arguments.iter().any(|argument| argument == "--json");
    let options = match parse(&installation, arguments) {
        Ok(value) => value,
        Err(error) => return fail(requested_json, "invalid_arguments", &error, 2),
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
        Err(error) => return fail(options.json, error.code, &error.message, 1),
    };
    let cancellation = CancellationToken::new();
    let signal_task = match signals(cancellation.clone()) {
        Ok(value) => value,
        Err(error) => return fail(options.json, "native_signal_unavailable", &error, 1),
    };
    let embedding = match NativeEmbeddingOwner::new(options.data.clone()) {
        Ok(value) => Arc::new(value),
        Err(error) => {
            signal_task.abort();
            let _ = signal_task.await;
            return fail(options.json, error.code, &error.message, 1);
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
            return fail(options.json, error.code, &error.message, 1);
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
                return fail(options.json, error.code, &error.message, 1);
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
            return fail(options.json, error.code, &error.message, 1);
        }
        (Ok(value), Ok(())) => value,
    };
    let after = match health.read().await {
        Ok(value) => value,
        Err(error) => return fail(options.json, error.code, &error.message, 1),
    };
    let data = json!({
        "exitCode":outcome.exit_code,"skipped":outcome.skipped,"phasesRun":outcome.phases_run,
        "aborted":outcome.aborted,"failedPhases":&outcome.failed_phases,
        "before":projection(&before),"after":projection(&after),
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
    NativeConsolidationCliResult {
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
    embedding: Arc<NativeEmbeddingOwner>,
    cancellation: &CancellationToken,
) -> crate::cognition::CognitionResult<crate::cognition::ConfiguredCycleResult> {
    let generation = resolve_active_generation(&options.data, paths)?;
    let os = nix::sys::utsname::uname().map_err(|_| error("native_environment_unavailable"))?;
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default();
    let environment =
        NativeProcessEnvironment::capture(&options.data, &home, &os.release().to_string_lossy());
    let collation =
        Arc::new(LocaleCollation::new("en-US").map_err(|_| error("native_locale_unavailable"))?);
    let models = NativeProcessModels::new(
        options.data.clone(),
        environment.model,
        Arc::new(ConfigurationWrites::new()),
        collation,
    )
    .map_err(|error| {
        crate::cognition::CognitionError::new("native_model_setup_failed", error.code())
    })?;
    let clock: Arc<dyn Fn() -> String + Send + Sync> = Arc::new(|| SystemIdentity.now_iso());
    let vectors = Arc::new(NativeGenerationVectorAdapter::new(
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
        NativeMemorySyncConsumer::new(
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
    let phases = Arc::new(NativeConfiguredPhases {
        consumer: consumer.clone(),
        consolidate: GraphConsolidationService::new(
            options.data.clone(),
            paths.clone(),
            coordinator.clone(),
        ),
        optimize: NativeVectorOptimizeService::new(
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

fn projection(report: &MemoryHealthReport) -> Value {
    json!({"maintenanceStatus":report.maintenance_status.as_str(),"queueBacklog":report.metric_dimensions["queue_backlog_count"],"graphEntityCount":report.metric_dimensions["graph_entities_count"],"graphEdgeCount":report.metric_dimensions["graph_edges_count"]})
}

fn parse(installation: &ResolvedInstallation, arguments: Vec<OsString>) -> Result<Options, String> {
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
            value if value.starts_with("--") => return Err(format!("unknown option: {value}")),
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
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default()
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
fn error(code: &'static str) -> crate::cognition::CognitionError {
    crate::cognition::CognitionError::new(code, code)
}
fn fail(json_mode: bool, code: &str, message: &str, exit_code: u8) -> NativeConsolidationCliResult {
    NativeConsolidationCliResult {
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

pub(super) fn signals(token: CancellationToken) -> Result<tokio::task::JoinHandle<()>, String> {
    use tokio::signal::unix::{SignalKind, signal};
    let mut interrupt = signal(SignalKind::interrupt()).map_err(|error| error.to_string())?;
    let mut terminate = signal(SignalKind::terminate()).map_err(|error| error.to_string())?;
    Ok(tokio::spawn(async move {
        tokio::select! { _=interrupt.recv()=>{},_=terminate.recv()=>{} }
        token.cancel();
    }))
}
