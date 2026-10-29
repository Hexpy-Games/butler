//! Post-commit cleanup debt, recovered only at startup or a deletion/archive.
use super::super::{
    AppApplication, AppAssetCommand, GatewayApplicationError, app_error, canon,
    storage::AppStorageError,
};
use rusqlite::OptionalExtension;
use std::sync::Arc;

const PAGE_SIZE: usize = 100;

#[derive(Debug, thiserror::Error)]
#[error("session cleanup failures: {0:?}")]
struct CleanupFailures(Vec<(String, GatewayApplicationError)>);

async fn complete(app: &AppApplication, session_id: String) -> Result<(), GatewayApplicationError> {
    let guard = app.session_cleanup_locks.acquire(session_id.clone()).await;
    complete_locked(app, session_id, &guard).await
}

/// Mutations keep this same lock from the archive/unarchive commit through
/// cleanup. A replay cannot remove outputs belonging to a newly unarchived turn.
pub(super) async fn complete_locked(
    app: &AppApplication,
    session_id: String,
    _guard: &tokio::sync::OwnedMutexGuard<()>,
) -> Result<(), GatewayApplicationError> {
    let id = session_id.clone();
    let record = app
        .storage
        .read(move |db| {
            db.query_row(
                "SELECT d.kind,d.session_hint,COALESCE(c.archived,0) \
                 FROM app_session_delete_cleanups d LEFT JOIN chats c ON c.id=d.session_id \
                 WHERE d.session_id=?1",
                [id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, bool>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(AppStorageError::sqlite)
        })
        .await
        .map_err(app_error)?;
    let Some((kind, hint, archived)) = record else {
        return Ok(());
    };
    let results = match (kind.as_str(), hint) {
        ("archive", _) if !archived => return clear_record(app, session_id).await,
        ("archive", _) => vec![(
            "outputs",
            app.collect_session_outputs(session_id.clone()).await,
        )],
        ("delete", Some(hint)) => delete_steps(app, session_id.clone(), hint).await,
        _ => return Err(GatewayApplicationError::internal()),
    };
    // No cleanup result controls whether a later step runs. Keep the durable
    // hint until every store has acknowledged cleanup, including on replay.
    let mut failures = Vec::new();
    for (step, result) in results {
        if let Err(error) = result {
            eprintln!("[session-cleanup] session={session_id} step={step} failed: {error:?}");
            failures.push((step.to_owned(), error));
        }
    }
    combine_failures(failures)?;
    clear_record(app, session_id).await
}

fn combine_failures(
    failures: Vec<(String, GatewayApplicationError)>,
) -> Result<(), GatewayApplicationError> {
    if let Some((_, first)) = failures.first() {
        // Preserve the first failure's HTTP mapping; attach every cause for logs.
        let mut error = first.clone();
        let (GatewayApplicationError::Public { source, .. }
        | GatewayApplicationError::Internal { source }) = &mut error;
        *source = Some(Arc::new(CleanupFailures(failures)));
        return Err(error);
    }
    Ok(())
}

pub(in crate::gateway::application) async fn complete_all(
    app: &AppApplication,
    sessions: Vec<String>,
) -> Result<(), GatewayApplicationError> {
    let mut failures = Vec::new();
    for session in sessions {
        if let Err(error) = complete(app, session.clone()).await {
            failures.push((session, error));
        }
    }
    combine_failures(failures)
}

async fn delete_steps(
    app: &AppApplication,
    session_id: String,
    hint: String,
) -> Vec<(&'static str, Result<(), GatewayApplicationError>)> {
    vec![
        (
            "outputs",
            app.collect_session_outputs(session_id.clone()).await,
        ),
        (
            "context",
            app.dependencies
                .authority_handoff
                .delete_session_context(hint)
                .await,
        ),
        ("files", {
            let _files = app.canon_file_lifetimes.lock().await;
            canon::files::sweep(app, false).await
        }),
        (
            "assets",
            app.assets_owned(AppAssetCommand::Sweep).await.map(|_| ()),
        ),
    ]
}

async fn clear_record(
    app: &AppApplication,
    session_id: String,
) -> Result<(), GatewayApplicationError> {
    let id = session_id.clone();
    let result = app
        .storage
        .execute(move |db| {
            db.execute(
                "DELETE FROM app_session_delete_cleanups WHERE session_id=?1",
                [id],
            )
            .map_err(AppStorageError::sqlite)?;
            Ok(())
        })
        .await
        .map_err(app_error);
    if let Err(error) = &result {
        eprintln!("[session-cleanup] session={session_id} clearing record failed: {error:?}");
    }
    result
}

pub(in crate::gateway::application) async fn replay(app: &AppApplication) {
    let mut after = String::new();
    loop {
        let cursor = after.clone();
        let page = app.storage.read(move |db| {
            let mut query = db.prepare(
                "SELECT session_id FROM app_session_delete_cleanups WHERE session_id>?1 ORDER BY session_id LIMIT ?2",
            ).map_err(AppStorageError::sqlite)?;
            query.query_map(rusqlite::params![cursor, PAGE_SIZE], |row| row.get::<_, String>(0))
                .map_err(AppStorageError::sqlite)?
                .collect::<Result<Vec<_>, _>>().map_err(AppStorageError::sqlite)
        }).await;
        let page = match page {
            Ok(page) => page,
            Err(error) => {
                eprintln!("[session-cleanup] loading records failed: {error:?}");
                return;
            }
        };
        let full = page.len() == PAGE_SIZE;
        for id in page {
            after = id.clone();
            if let Err(error) = complete(app, id.clone()).await {
                eprintln!("[session-cleanup] session={id} replay failed: {error:?}");
            }
        }
        if !full {
            return;
        }
    }
}
