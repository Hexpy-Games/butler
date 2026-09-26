//! Read cache and explicit generation lifecycle for project signposts.

use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::super::super::{AppStorageError, app_error};
use super::super::contracts::{AppProjectDashboardBriefingRequest, source_changed};
use super::super::{AppApplication, GatewayApplicationError};
use super::generation;
use super::pack::{self, GENERATOR_VERSION, Pack, PackInput};
use super::{BriefingState, ProjectDashboardBriefingOwner};
use crate::gateway::application::events;

pub(super) async fn read(
    application: &AppApplication,
    project_id: &str,
) -> Result<Value, GatewayApplicationError> {
    let pack = read_pack(application, project_id).await?;
    view(application, &pack).await
}

pub(super) async fn request(
    application: &AppApplication,
    project_id: &str,
    request: AppProjectDashboardBriefingRequest,
) -> Result<Value, GatewayApplicationError> {
    let owner = application.project_dashboard_briefing.clone();
    if owner.is_closing() {
        return Err(briefing_unavailable());
    }
    let pack = read_pack(application, project_id).await?;
    if pack.revision != request.source_revision {
        return Err(source_changed("Source changed. Reload it."));
    }
    let current = view_for_pack(application, &pack).await?;
    if current["status"].as_str() == Some("ready")
        || current["status"].as_str() == Some("generating")
        || pack.sources.is_empty()
    {
        return Ok(current);
    }
    let preferences_revision = application
        .storage
        .execute({
            let project_id = project_id.to_owned();
            move |db| {
                db.query_row(
                    "SELECT dashboard_preferences_revision FROM projects WHERE id=?1",
                    [project_id],
                    |row| row.get::<_, i64>(0),
                )
                .map(|value| u64::try_from(value.max(0)).unwrap_or_default())
                .map_err(AppStorageError::sqlite)
            }
        })
        .await
        .map_err(app_error)?;
    let task_application = application.clone_handle();
    let task_owner = owner.clone();
    let port = application.dependencies.project_dashboard_briefing.clone();
    let task_pack = pack.clone();
    let state = owner.start(
        pack.revision.clone(),
        request.retry,
        move |cancellation| async move {
            finish(
                task_application,
                task_owner,
                port,
                task_pack,
                preferences_revision,
                cancellation,
            )
            .await;
        },
    );
    let mut current = current;
    current["status"] = json!(status_text(state));
    Ok(current)
}

async fn read_pack(
    application: &AppApplication,
    project_id: &str,
) -> Result<Pack, GatewayApplicationError> {
    let project = super::super::project::read_project(application, project_id).await?;
    let settings = application.worker_profile_settings().await?;
    let model = settings
        .get("effective_consolidation_model")
        .and_then(Value::as_str)
        .ok_or(GatewayApplicationError::Internal)?
        .to_owned();
    let reasoning_effort = settings
        .get("consolidation_reasoning_effort")
        .and_then(Value::as_str)
        .unwrap_or("xhigh")
        .to_owned();
    let settings_context = settings
        .get("context_window_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(258_000);
    let model_context = application
        .dependencies
        .settings_facts
        .snapshot()?
        .known_models
        .iter()
        .find(|known| known.model_ref == model)
        .and_then(|known| known.context_window_tokens)
        .unwrap_or(settings_context);
    let snapshot = match project.ledger_project_id.as_deref() {
        Some(ledger_id) => application
            .dependencies
            .project_dashboard_ledger
            .snapshot(project.id.clone(), ledger_id.to_owned())
            .await
            .ok(),
        None => None,
    };
    pack::build(
        application,
        PackInput {
            project_id: project.id,
            binding: project.ledger_project_id,
            description: project.description,
            model,
            reasoning_effort,
            context_tokens: model_context,
            language: pack::resolve_language(&application.butler_data),
            snapshot,
        },
    )
    .await
}

async fn view(application: &AppApplication, pack: &Pack) -> Result<Value, GatewayApplicationError> {
    view_for_pack(application, pack).await
}

async fn view_for_pack(
    application: &AppApplication,
    pack: &Pack,
) -> Result<Value, GatewayApplicationError> {
    let project_id = pack.project_id.clone();
    let language = pack.language.clone();
    let cached = application
        .storage
        .execute(move |db| {
            db.query_row(
                "SELECT content_json,generated_at,source_digest FROM project_dashboard_briefing_cache \
                 WHERE project_id=?1 AND response_language=?2 AND generator_version=?3",
                params![project_id, language, GENERATOR_VERSION],
                |row| {
                    Ok(CacheRow {
                        content_json: row.get(0)?,
                        generated_at: row.get(1)?,
                        source_digest: row.get(2)?,
                    })
                },
            )
            .optional()
            .map_err(AppStorageError::sqlite)
        })
        .await
        .map_err(app_error)?;
    let base = json!({
        "sourceRevision":pack.revision,
        "language":pack.language,
        "coverage":pack::public_coverage(pack)?,
        "sources":pack::public_sources(pack)?,
        "candidates":pack::public_candidates(pack)?,
    });
    if let Some(cached) = cached.filter(|row| row.source_digest == pack.revision)
        && let Ok(content) = generation::validate(&cached.content_json, pack)
    {
        return Ok(json!({
            "sourceRevision":pack.revision,
            "language":pack.language,
            "coverage":pack::public_coverage(pack)?,
            "sources":pack::public_sources(pack)?,
            "candidates":pack::public_candidates(pack)?,
            "status":"ready",
            "content":content,
            "generatedAt":cached.generated_at,
        }));
    }
    let status = if pack.sources.is_empty() {
        BriefingState::Unavailable
    } else {
        application.project_dashboard_briefing.state(&pack.revision)
    };
    let mut output = base;
    output["status"] = json!(status_text(status));
    Ok(output)
}

async fn finish(
    application: AppApplication,
    owner: ProjectDashboardBriefingOwner,
    port: std::sync::Arc<dyn super::super::contracts::AppProjectDashboardBriefingPort>,
    pack: Pack,
    preferences_revision: u64,
    cancellation: CancellationToken,
) {
    let _ = finish_generation(
        &application,
        &owner,
        port,
        &pack,
        preferences_revision,
        cancellation,
    )
    .await;
    if !owner.is_closing() {
        let _ = publish_update(&application, &owner, &pack.project_id).await;
    }
}

async fn finish_generation(
    application: &AppApplication,
    owner: &ProjectDashboardBriefingOwner,
    port: std::sync::Arc<dyn super::super::contracts::AppProjectDashboardBriefingPort>,
    pack: &Pack,
    preferences_revision: u64,
    cancellation: CancellationToken,
) -> Result<(), ()> {
    let request = generation::prompt(pack).map_err(|_| ())?;
    let raw = port
        .generate(request, cancellation.clone())
        .await
        .map_err(|_| ())?;
    if owner.is_closing() || cancellation.is_cancelled() {
        return Err(());
    }
    let content = generation::validate(&raw, pack)?;
    let current = read_pack(application, &pack.project_id)
        .await
        .map_err(|_| ())?;
    if current.revision != pack.revision || owner.is_closing() || cancellation.is_cancelled() {
        return Err(());
    }
    let mut cache_pack = pack.clone();
    if pack.description.is_empty() {
        let description = content["introduction"].as_str().ok_or(())?.to_owned();
        let initialized = application
            .storage
            .execute({
                let project_id = pack.project_id.clone();
                let owner = owner.clone();
                move |db| {
                    owner.with_open(|| {
                        db.execute(
                            "UPDATE projects SET description=?1,dashboard_preferences_revision=dashboard_preferences_revision+1 \
                             WHERE id=?2 AND description IS NULL AND dashboard_preferences_revision=?3",
                            params![description, project_id, i64::try_from(preferences_revision).unwrap_or(i64::MAX)],
                        )
                        .map(|changed| changed == 1)
                        .map_err(AppStorageError::sqlite)
                    })
                    .unwrap_or(Ok(false))
                }
            })
            .await
            .map_err(|_| ())?;
        if initialized {
            let refreshed = read_pack(application, &pack.project_id)
                .await
                .map_err(|_| ())?;
            if refreshed.reasoning_effort != pack.reasoning_effort
                || refreshed.description != content["introduction"].as_str().unwrap_or_default()
                || !pack::same_source_inputs(pack, &refreshed)
            {
                return Err(());
            }
            cache_pack = refreshed;
        }
    }
    if owner.is_closing() || cancellation.is_cancelled() {
        return Err(());
    }
    let cache_json = serde_json::to_string(&content).map_err(|_| ())?;
    let generated_at = application.dependencies.identity_clock.now_iso();
    let project_id = cache_pack.project_id.clone();
    let binding = cache_pack.binding.clone();
    let source_digest = cache_pack.revision.clone();
    let language = cache_pack.language.clone();
    let owner_for_write = owner.clone();
    let cached = application
        .storage
        .execute(move |db| {
            owner_for_write
                .with_open(|| {
                    let transaction = db.transaction().map_err(AppStorageError::sqlite)?;
                    transaction
                        .execute(
                            "INSERT INTO project_dashboard_briefing_cache \
                             (project_id,binding_revision,source_digest,response_language,generator_version,content_json,generated_at) \
                             VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(project_id,response_language) DO UPDATE SET \
                             binding_revision=excluded.binding_revision,source_digest=excluded.source_digest, \
                             generator_version=excluded.generator_version,content_json=excluded.content_json,generated_at=excluded.generated_at",
                            params![project_id, binding, source_digest, language, GENERATOR_VERSION, cache_json, generated_at],
                        )
                        .map_err(AppStorageError::sqlite)?;
                    transaction.commit().map_err(AppStorageError::sqlite)?;
                    Ok(true)
                })
                .unwrap_or(Ok(false))
        })
        .await
        .map_err(|_| ())?;
    if !cached {
        return Err(());
    }
    Ok(())
}

async fn publish_update(
    application: &AppApplication,
    owner: &ProjectDashboardBriefingOwner,
    project_id: &str,
) -> Result<(), GatewayApplicationError> {
    if owner.is_closing() {
        return Ok(());
    }
    let project_id = project_id.to_owned();
    let created_at = application.dependencies.identity_clock.now_iso();
    let subscribers = application.subscribers.clone();
    let event = application
        .storage
        .execute({
            let owner = owner.clone();
            move |db| {
                owner
                    .with_open(|| {
                        let payload = json!({"project_id":project_id})
                            .as_object()
                            .cloned()
                            .ok_or_else(|| {
                                AppStorageError::new(
                                    "app_event_json_failed",
                                    "Invalid event payload.",
                                )
                            })?;
                        let event = events::append_unpublished(
                            db,
                            "project_dashboard_updated",
                            None,
                            payload,
                            &created_at,
                        )?;
                        Ok(Some(event))
                    })
                    .unwrap_or(Ok(None))
            }
        })
        .await
        .map_err(app_error)?;
    if let Some(event) = event {
        events::publish(&subscribers, &event);
    }
    Ok(())
}

fn status_text(state: BriefingState) -> &'static str {
    match state {
        BriefingState::Needed => "needed",
        BriefingState::Generating => "generating",
        BriefingState::Unavailable => "unavailable",
    }
}

fn briefing_unavailable() -> GatewayApplicationError {
    GatewayApplicationError::Public {
        status: 503,
        code: "briefing_unavailable".into(),
        message: "Briefing unavailable.".into(),
    }
}

struct CacheRow {
    content_json: String,
    generated_at: String,
    source_digest: String,
}
