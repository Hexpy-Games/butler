use std::{path::PathBuf, sync::Arc, time::Duration};

use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::{
    cognition::{
        CognitionPathEnvironment, LegacyIndexService, LegacyMemoryImportPlan,
        LegacyMemoryImportService, ensure_data_authority, extract_legacy_import_transcript,
    },
    configuration::ConfigurationWrites,
    locale::LocaleCollation,
    models::{ProviderPromptLifecycle, ProviderPromptPort, ProviderPromptRequest},
    workspace::{
        SessionBindingStore, SessionBindingStoreConfig, WorkspaceStorageProfile, session_store_path,
    },
};

use super::CliError;

pub(super) async fn run(
    data_root: PathBuf,
    paths: CognitionPathEnvironment,
    session_id: &str,
    dry_run: bool,
    coordinator: Arc<crate::coordination::CognitionWriteCoordinator>,
) -> Result<(Value, String), CliError> {
    let importer = LegacyMemoryImportService::new(data_root.clone(), paths.clone());
    let mut plan = importer
        .plan(session_id)
        .map_err(|error| CliError::failed(error.code, error.message))?;
    let project = bound_project(&data_root, &plan).await?;
    importer
        .resolve_project(&mut plan, project.as_deref())
        .map_err(|error| CliError::failed(error.code, error.message))?;
    let mut data = plan_data(&plan, dry_run);
    if dry_run {
        return Ok((
            data,
            format!(
                "Memory ingest dry-run: session={} messages={} chunks={}",
                plan.session_id,
                plan.message_count,
                plan.chunks.len()
            ),
        ));
    }

    importer
        .prepare_apply()
        .map_err(|error| CliError::failed(error.code, error.message))?;
    if plan.message_count == 0
        || importer
            .already_imported(&plan.session_id)
            .map_err(|error| CliError::failed(error.code, error.message))?
    {
        data["applied"] = json!(true);
        return Ok((
            data,
            format!(
                "Memory ingest applied: session={} chunks={}",
                plan.session_id,
                plan.chunks.len()
            ),
        ));
    }

    let cancellation = CancellationToken::new();
    let mut warnings = Vec::new();
    let mut models: Option<crate::host::NativeProcessModels> = None;
    let mut model_setup_failure: Option<String> = None;
    let mut embedding = None;
    let mut index: Option<LegacyIndexService> = None;
    let mut saved_count = 0usize;
    let mut graph_count = 0usize;

    for chunk in &plan.chunks {
        if chunk.conversation_text.trim().is_empty() {
            continue;
        }
        let summary = match configured_summary(
            &mut models,
            &mut model_setup_failure,
            &data_root,
            &chunk.hot_text,
            &cancellation,
        )
        .await
        {
            Ok(summary) => summary,
            Err(code) => {
                warnings.push(warning(&chunk.chunk_id, "summarize", &code));
                record_raw_graph(
                    &data_root,
                    &paths,
                    chunk,
                    &plan,
                    &mut graph_count,
                    &mut warnings,
                );
                continue;
            }
        };

        let index_text = match LegacyIndexService::write_legacy_import_summary(
            &data_root,
            &paths,
            coordinator.clone(),
            &summary,
            &plan.project,
            &chunk.chunk_id,
        )
        .await
        {
            Ok(text) => text,
            Err(error) => {
                warnings.push(warning(&chunk.chunk_id, "hot_cache", error.code));
                record_raw_graph(
                    &data_root,
                    &paths,
                    chunk,
                    &plan,
                    &mut graph_count,
                    &mut warnings,
                );
                continue;
            }
        };
        saved_count += 1;
        match ensure_index_owner(
            &data_root,
            &paths,
            coordinator.clone(),
            &mut embedding,
            &mut index,
        )
        .await
        {
            Ok(service) => {
                let vector_session = crate::cognition::normalize_session_id_for_storage(&format!(
                    "hot_{}",
                    chunk.chunk_id
                ));
                if let Err(error) = service
                    .index_hot_entry(
                        &index_text,
                        &vector_session,
                        &chunk.chunk_id,
                        &plan.project,
                        None,
                        &cancellation,
                    )
                    .await
                {
                    warnings.push(warning(&chunk.chunk_id, "hot_index", error.code));
                }
            }
            Err(code) => warnings.push(warning(&chunk.chunk_id, "embedding_setup", &code)),
        }
        record_raw_graph(
            &data_root,
            &paths,
            chunk,
            &plan,
            &mut graph_count,
            &mut warnings,
        );
    }

    let marker_result = importer
        .mark_imported(&plan.session_id)
        .map_err(|error| CliError::failed(error.code, error.message));
    if let Some(embedding) = embedding
        && let Err(error) = embedding.close().await
    {
        warnings.push(warning(&plan.session_id, "embedding_close", error.code));
    }
    marker_result?;
    data["applied"] = json!(true);
    data["savedChunks"] = json!(saved_count);
    data["graphEntities"] = json!(graph_count);
    data["warnings"] = json!(warnings);
    let human = format!(
        "Memory ingest applied: session={} chunks={} warnings={}",
        plan.session_id,
        plan.chunks.len(),
        data["warnings"].as_array().map_or(0, Vec::len),
    );
    Ok((data, human))
}

fn plan_data(plan: &LegacyMemoryImportPlan, dry_run: bool) -> Value {
    json!({
        "dryRun": dry_run,
        "sessionId": plan.session_id,
        "project": plan.project,
        "format": plan.format,
        "transcriptPath": plan.transcript_path,
        "messages": plan.message_count,
        "chunks": plan.chunks.len(),
        "rawTextIncluded": false,
    })
}

async fn bound_project(
    data_root: &std::path::Path,
    plan: &LegacyMemoryImportPlan,
) -> Result<Option<String>, CliError> {
    if plan.format != "butler-transcript" {
        return Ok(None);
    }
    let path = session_store_path(data_root);
    let runtime = data_root.join("runtime");
    ensure_data_authority(data_root, &[&runtime, &path])
        .map_err(|error| CliError::failed(error.code, error.message))?;
    let store = SessionBindingStore::open(SessionBindingStoreConfig {
        path,
        storage_profile: WorkspaceStorageProfile::Durable,
        clock: Arc::new(crate::host::SystemIdentity),
    })
    .await
    .map_err(|error| CliError::failed(error.code, error.message))?;
    let result = store
        .get_by_session_id(&plan.session_id)
        .await
        .map(|binding| binding.and_then(|binding| binding.project_id));
    let closed = store.close().await;
    match (result, closed) {
        (Err(error), _) | (Ok(_), Err(error)) => Err(CliError::failed(error.code, error.message)),
        (Ok(project), Ok(())) => Ok(project),
    }
}

async fn configured_summary(
    models: &mut Option<crate::host::NativeProcessModels>,
    setup_failure: &mut Option<String>,
    data_root: &std::path::Path,
    text: &str,
    cancellation: &CancellationToken,
) -> Result<String, String> {
    if models.is_none() && setup_failure.is_none() {
        match process_models(data_root) {
            Ok(value) => *models = Some(value),
            Err(code) => *setup_failure = Some(code),
        }
    }
    let Some(models) = models.as_ref() else {
        return Err(setup_failure
            .clone()
            .unwrap_or_else(|| "native_model_setup_failed".into()));
    };
    let text = crate::public_text::trim_js_whitespace(text);
    if text.is_empty() {
        return Err("hot_cache_entry_empty".into());
    }
    if text.starts_with("**") {
        return Ok(text.to_owned());
    }
    let prompt = format!(
        "Analyze the following conversation and summarize it in the format below. Omit any sections that don't apply.\n\n**Task**: Work performed, decisions made, completed/incomplete items (dev/file/search etc.)\n**Learning**: New concepts learned, important insights\n**Chat**: Core of casual conversation, exchange of opinions\n**Preference**: User preferences/tastes/tendencies newly revealed in this conversation (exclude recurring ones)\n\nEach section in 1-2 lines max. Omit the section entirely if empty.\n\nConversation:\n{text}"
    );
    let data = data_root.to_string_lossy().into_owned();
    tokio::time::timeout(
        Duration::from_secs(120),
        models.provider.run_prompt(
            ProviderPromptRequest {
                prompt: &prompt,
                model: None,
                reasoning_effort: None,
                instructions: None,
                response_format: None,
                cache_scope: None,
                cache_boundary: None,
                cancellation: cancellation.clone(),
                attachments: &[],
                butler_data: Some(&data),
                usage_attribution: None,
                stream_observer: None,
                provider_retry_attempts: None,
            },
            ProviderPromptLifecycle::none(),
        ),
    )
    .await
    .map_err(|_| "legacy_hot_summary_timeout".to_owned())?
    .map(|result| result.text)
    .map_err(|_| "legacy_hot_summary_failed".to_owned())
}

fn process_models(data_root: &std::path::Path) -> Result<crate::host::NativeProcessModels, String> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| data_root.to_owned());
    let os_release = nix::sys::utsname::uname()
        .map(|value| value.release().to_string_lossy().into_owned())
        .unwrap_or_else(|_| "unknown".into());
    let environment = crate::host::NativeProcessEnvironment::capture(data_root, &home, &os_release);
    let collation = Arc::new(
        LocaleCollation::new("en-US").map_err(|_| "native_locale_unavailable".to_owned())?,
    );
    crate::host::NativeProcessModels::new(
        data_root.to_owned(),
        environment.model,
        Arc::new(ConfigurationWrites::new()),
        collation,
    )
    .map_err(|error| error.code)
}

async fn ensure_index_owner<'a>(
    data_root: &std::path::Path,
    paths: &CognitionPathEnvironment,
    coordinator: Arc<crate::coordination::CognitionWriteCoordinator>,
    embedding: &mut Option<Arc<crate::host::NativeEmbeddingOwner>>,
    index: &'a mut Option<LegacyIndexService>,
) -> Result<&'a LegacyIndexService, String> {
    if index.is_none() {
        let owner = match embedding {
            Some(owner) => owner.clone(),
            None => embedding
                .insert(Arc::new(
                    crate::host::NativeEmbeddingOwner::new(data_root.to_owned())
                        .map_err(|error| error.code)?,
                ))
                .clone(),
        };
        *index = Some(LegacyIndexService::new(
            data_root.to_owned(),
            paths.clone(),
            coordinator,
            owner,
        ));
    }
    index
        .as_ref()
        .ok_or_else(|| "memory_index_unavailable".to_owned())
}

fn record_raw_graph(
    data_root: &std::path::Path,
    paths: &CognitionPathEnvironment,
    chunk: &crate::cognition::LegacyMemoryImportChunk,
    plan: &LegacyMemoryImportPlan,
    graph_count: &mut usize,
    warnings: &mut Vec<Value>,
) {
    match extract_legacy_import_transcript(
        data_root,
        paths,
        &chunk.conversation_text,
        &chunk.chunk_id,
        &plan.project,
    ) {
        Ok(count) => *graph_count += count,
        Err(error) => warnings.push(warning(&chunk.chunk_id, "graph_extract", error.code)),
    }
}

fn warning(chunk: &str, step: &str, code: &str) -> Value {
    json!({"chunkId": chunk, "step": step, "code": code})
}
