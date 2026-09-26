//! Operator rebuild preparation and read-only candidate inspection.

mod build;
mod options;
mod repair_inputs;
mod retry_failed;
mod rollback;
mod set_extractor;

use std::{ffi::OsString, sync::Arc};

use serde_json::json;
use tokio_util::sync::CancellationToken;

use crate::{
    cognition::{
        CognitionError, CognitionPathEnvironment, activate_memory_rebuild, ensure_data_authority,
        inspect_memory_rebuild, prepare_memory_rebuild, validate_memory_rebuild,
    },
    conversation::{
        AgentConversationStore, ConversationStoreConfig, classify_historical_origins,
        conversation_store_path,
    },
    coordination::{CognitionWaitClass, CognitionWriteAcquire, CognitionWriteCoordinator},
    locale::LocaleCollation,
    models::ModelConfigurationClock,
};

use super::{
    ResolvedInstallation, SystemIdentity, consolidation_cli::NativeConsolidationCliResult,
    memory_maintain::signals,
};

use options::{Operation, parse};

pub async fn run(
    installation: ResolvedInstallation,
    arguments: Vec<OsString>,
) -> NativeConsolidationCliResult {
    let requested_json = arguments.iter().any(|arg| arg == "--json");
    let options = match parse(&installation, arguments) {
        Ok(options) => options,
        Err(message) => return failure(requested_json, "invalid_arguments", &message, 2),
    };
    let paths = CognitionPathEnvironment {
        cognition_home: std::env::var("BUTLER_COGNITION_HOME").ok(),
        memory_home: std::env::var("BUTLER_COGNITION_MEMORY_HOME").ok(),
    };
    let result = match &options.operation {
        Operation::Inspect(generation) => inspect_memory_rebuild(&options.data, &paths, generation)
            .map(|value| json!({"operation":"inspect","result":value})),
        Operation::Prepare => {
            let coordinator = match CognitionWriteCoordinator::new(Arc::new(SystemIdentity)) {
                Ok(value) => Arc::new(value),
                Err(error) => return failure(options.json, error.code(), &error.message(), 1),
            };
            let cancellation = CancellationToken::new();
            let signal_task = match signals(cancellation.clone()) {
                Ok(value) => value,
                Err(message) => {
                    return failure(options.json, "native_signal_unavailable", &message, 1);
                }
            };
            let (major, minor, patch) = unicode_segmentation::UNICODE_VERSION;
            let prepared =
                match classify_before_prepare(&options.data, &paths, &coordinator, &cancellation)
                    .await
                {
                    Ok(()) => {
                        prepare_memory_rebuild(
                            options.data.clone(),
                            paths,
                            coordinator,
                            cancellation,
                            SystemIdentity.now_iso(),
                            format!("{major}.{minor}.{patch}"),
                            LocaleCollation::implementation_version().to_owned(),
                        )
                        .await
                    }
                    Err(error) => Err(error),
                };
            signal_task.abort();
            let _ = signal_task.await;
            prepared.map(|value| {
                json!({"operation":"prepare","generationId":value.generation_id,
                "canonicalSnapshotId":value.canonical_snapshot_id,
                "sourceInventoryHash":value.source_inventory_hash,
                "unaccountedSourceCount":value.unaccounted_source_count})
            })
        }
        Operation::Build(generation) => {
            let coordinator = match CognitionWriteCoordinator::new(Arc::new(SystemIdentity)) {
                Ok(value) => Arc::new(value),
                Err(error) => return failure(options.json, error.code(), &error.message(), 1),
            };
            let cancellation = CancellationToken::new();
            let signal_task = match signals(cancellation.clone()) {
                Ok(value) => value,
                Err(message) => {
                    return failure(options.json, "native_signal_unavailable", &message, 1);
                }
            };
            let result = build::run(
                &options.data,
                &paths,
                coordinator,
                generation,
                &cancellation,
            )
            .await;
            signal_task.abort();
            let _ = signal_task.await;
            result.map(|result| json!({"operation":"build","result":result}))
        }
        Operation::Validate {
            generation,
            acceptance,
        } => {
            let coordinator = match CognitionWriteCoordinator::new(Arc::new(SystemIdentity)) {
                Ok(value) => Arc::new(value),
                Err(error) => return failure(options.json, error.code(), &error.message(), 1),
            };
            let cancellation = CancellationToken::new();
            let signal_task = match signals(cancellation.clone()) {
                Ok(value) => value,
                Err(message) => {
                    return failure(options.json, "native_signal_unavailable", &message, 1);
                }
            };
            let result =
                match classify_before_prepare(&options.data, &paths, &coordinator, &cancellation)
                    .await
                {
                    Ok(()) => {
                        validate_memory_rebuild(
                            &options.data,
                            &paths,
                            coordinator,
                            generation,
                            acceptance,
                            &cancellation,
                            option_env!("BUTLER_MEMORY_VERIFIED_COMMIT"),
                        )
                        .await
                    }
                    Err(error) => Err(error),
                };
            signal_task.abort();
            let _ = signal_task.await;
            result.map(|manifest| json!({"operation":"validate","manifest":manifest}))
        }
        Operation::Activate {
            generation,
            expected_active,
        } => {
            let coordinator = match CognitionWriteCoordinator::new(Arc::new(SystemIdentity)) {
                Ok(value) => Arc::new(value),
                Err(error) => return failure(options.json, error.code(), &error.message(), 1),
            };
            let cancellation = CancellationToken::new();
            let signal_task = match signals(cancellation.clone()) {
                Ok(value) => value,
                Err(message) => {
                    return failure(options.json, "native_signal_unavailable", &message, 1);
                }
            };
            let result =
                match classify_before_prepare(&options.data, &paths, &coordinator, &cancellation)
                    .await
                {
                    Ok(()) => {
                        activate_memory_rebuild(
                            &options.data,
                            &paths,
                            coordinator,
                            generation,
                            expected_active.as_deref(),
                            &SystemIdentity.now_iso(),
                            &cancellation,
                        )
                        .await
                    }
                    Err(error) => Err(error),
                };
            signal_task.abort();
            let _ = signal_task.await;
            result.map(|descriptor| json!({"operation":"activate","descriptor":descriptor}))
        }
        Operation::Rollback { generation } => {
            let coordinator = match CognitionWriteCoordinator::new(Arc::new(SystemIdentity)) {
                Ok(value) => Arc::new(value),
                Err(error) => return failure(options.json, error.code(), &error.message(), 1),
            };
            let cancellation = CancellationToken::new();
            let signal_task = match signals(cancellation.clone()) {
                Ok(value) => value,
                Err(message) => {
                    return failure(options.json, "native_signal_unavailable", &message, 1);
                }
            };
            let result = rollback::run(
                &options.data,
                &paths,
                coordinator,
                generation,
                &cancellation,
            )
            .await;
            signal_task.abort();
            let _ = signal_task.await;
            result.map(|outcome| json!({"operation":"rollback","result":outcome}))
        }
        Operation::RetryFailed {
            generation,
            vector_repair_input,
        } => {
            retry_failed::run(
                &options.data,
                &paths,
                generation,
                vector_repair_input.as_deref(),
            )
            .await
        }
        Operation::SetExtractor { generation, policy } => {
            set_extractor::run(&options.data, &paths, generation, policy.clone()).await
        }
        Operation::RepairInputs {
            generation,
            input,
            dry_run,
        } => match input {
            Some(path) => {
                repair_inputs::run(&options.data, &paths, generation, path, *dry_run).await
            }
            None => Err(CognitionError::new(
                "memory_rebuild_invalid_request",
                "memory_rebuild_invalid_request",
            )),
        },
    };
    match result {
        Ok(value) => NativeConsolidationCliResult {
            stdout: if options.json {
                format!(
                    "{}\n",
                    json!({"ok":true,"command":"butler cognition memory rebuild","data":value})
                )
            } else {
                format!("{value}\n")
            },
            stderr: String::new(),
            exit_code: 0,
        },
        Err(error) => failure(options.json, error.code, &error.message, 1),
    }
}

async fn classify_before_prepare(
    data_root: &std::path::Path,
    paths: &CognitionPathEnvironment,
    coordinator: &Arc<CognitionWriteCoordinator>,
    cancellation: &CancellationToken,
) -> Result<(), CognitionError> {
    let canonical = conversation_store_path(data_root);
    let lock = paths.consolidation_lock(data_root);
    ensure_data_authority(data_root, &[&canonical, &lock])?;
    let lease = coordinator
        .acquire(
            CognitionWriteAcquire {
                lock_path: lock,
                purpose: Some("historical_origin_classification".into()),
                deadline_at_epoch_ms: None,
                cancellation: Some(cancellation.clone()),
            },
            CognitionWaitClass::Background,
        )
        .await
        .map_err(CognitionError::from)?
        .ok_or_else(|| {
            CognitionError::new(
                "memory_write_lock_unavailable",
                "historical classification lock unavailable",
            )
        })?;
    let collation = Arc::new(LocaleCollation::new("en").map_err(|error| {
        CognitionError::new("memory_origin_collation_unavailable", error.to_string())
    })?);
    let store = AgentConversationStore::open(ConversationStoreConfig {
        path: canonical,
        identity_clock: Arc::new(SystemIdentity),
        collation,
    })
    .await
    .map_err(|error| CognitionError::new(error.code(), error.message()))?;
    let result = classify_historical_origins(data_root.to_path_buf(), &store, cancellation)
        .await
        .map_err(|error| CognitionError::new(error.code(), error.message()));
    let closed = store
        .close()
        .await
        .map_err(|error| CognitionError::new(error.code(), error.message()));
    drop(lease);
    result?;
    closed?;
    Ok(())
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
                json!({"ok":false,"command":"butler cognition memory rebuild","error":{"code":code,"message":message}})
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
