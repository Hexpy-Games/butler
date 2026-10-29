//! Post-commit cleanup debt, recovered only at startup or a permanent deletion.
use super::super::{
    AppApplication, AppAssetCommand, GatewayApplicationError, app_error, canon,
    storage::AppStorageError,
};
use rusqlite::OptionalExtension;
use std::sync::Arc;

const PAGE_SIZE: usize = 100;

#[derive(Debug, thiserror::Error)]
#[error("session delete cleanup failures: {0:?}")]
struct CleanupFailures(Vec<(&'static str, GatewayApplicationError)>);

pub(in crate::gateway::application) async fn complete(
    app: &AppApplication,
    session_id: String,
) -> Result<(), GatewayApplicationError> {
    let id = session_id.clone();
    let hint = app
        .storage
        .read(move |db| {
            db.query_row(
                "SELECT session_hint FROM app_session_delete_cleanups WHERE session_id=?1",
                [id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(AppStorageError::sqlite)
        })
        .await
        .map_err(app_error)?;
    let Some(hint) = hint else { return Ok(()) };
    // No cleanup result controls whether a later step runs. Keep the durable
    // hint until every store has acknowledged cleanup, including on replay.
    let results = [
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
    ];
    let mut failures = Vec::new();
    for (step, result) in results {
        if let Err(error) = result {
            eprintln!(
                "[session-delete-cleanup] session={session_id} step={step} failed: {error:?}"
            );
            failures.push((step, error));
        }
    }
    if let Some((_, first)) = failures.first() {
        // Preserve the first failure's HTTP mapping; attach every cause for logs.
        let mut error = first.clone();
        let (GatewayApplicationError::Public { source, .. }
        | GatewayApplicationError::Internal { source }) = &mut error;
        *source = Some(Arc::new(CleanupFailures(failures)));
        return Err(error);
    }
    clear_record(app, session_id).await
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
        eprintln!(
            "[session-delete-cleanup] session={session_id} clearing record failed: {error:?}"
        );
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
                eprintln!("[session-delete-cleanup] loading records failed: {error:?}");
                return;
            }
        };
        let full = page.len() == PAGE_SIZE;
        for id in page {
            after = id.clone();
            if let Err(error) = complete(app, id.clone()).await {
                eprintln!("[session-delete-cleanup] session={id} replay failed: {error:?}");
            }
        }
        if !full {
            return;
        }
    }
}
