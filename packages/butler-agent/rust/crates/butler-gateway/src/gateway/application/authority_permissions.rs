use super::{AppApplication, AppGrantRef, AppGrantView, app_error, storage::AppStorageError};
use crate::gateway::ApplicationFuture;
use crate::gateway::{GatewayApplication, GatewayApplicationError};

use std::collections::HashMap;

impl AppApplication {
    pub(super) fn revoke_authority_permissions(
        &self,
        grants: Vec<AppGrantRef>,
    ) -> ApplicationFuture<()> {
        let this = self.clone_handle();
        Box::pin(async move {
            this.dependencies
                .authority_handoff
                .revoke_permissions(grants)
                .await?;
            this.publish_gateway_event("authority.permissions_revoked", serde_json::Map::new())
                .await
        })
    }

    pub(super) async fn all_authority_permissions(
        &self,
    ) -> Result<Vec<AppGrantView>, GatewayApplicationError> {
        let started = std::time::Instant::now();
        let mut grants = self
            .dependencies
            .authority_handoff
            .list_all_permissions()
            .await?;
        let authority_us = started.elapsed().as_micros();
        let owners: Vec<_> = grants
            .iter()
            .map(|g| g.session_id.as_str())
            .collect::<std::collections::HashSet<_>>()
            .into_iter()
            .map(str::to_owned)
            .collect();
        let metadata = self
            .storage
            // Reuse the startup-owned connection. The barrier commits earlier
            // writes; this single statement then reads a fresh SQLite snapshot.
            .exclusive(move |db| {
                let started = std::time::Instant::now();
                let owners = serde_json::to_string(&owners).map_err(|error| {
                    AppStorageError::new(
                        super::storage::AppStorageCode::AppSqliteError,
                        error.to_string(),
                    )
                })?;
                let mut metadata = HashMap::new();
                // Resolve explicit runtime hints first, then only unrotated legacy ids.
                // Batch all owners in one statement using the existing lookup indexes.
                let mut query = db
                    .prepare_cached(METADATA_SQL)
                    .map_err(AppStorageError::sqlite)?;
                let mut rows = query.query([owners]).map_err(AppStorageError::sqlite)?;
                while let Some(row) = rows.next().map_err(AppStorageError::sqlite)? {
                    metadata.insert(
                        row.get::<_, String>(0).map_err(AppStorageError::sqlite)?,
                        (
                            row.get::<_, String>(1).map_err(AppStorageError::sqlite)?,
                            row.get::<_, Option<String>>(2)
                                .map_err(AppStorageError::sqlite)?,
                            row.get::<_, Option<String>>(3)
                                .map_err(AppStorageError::sqlite)?,
                        ),
                    );
                }
                if std::env::var("BUTLER_E2E_STORAGE_METRICS").as_deref() == Ok("1") {
                    eprintln!(
                        "approvals-profile metadata_sql_us={} metadata_lane_owned=1",
                        started.elapsed().as_micros()
                    );
                }
                Ok(metadata)
            })
            .await
            .map_err(app_error)?;
        let metadata_us = started.elapsed().as_micros() - authority_us;
        for grant in &mut grants {
            let row = metadata.get(&grant.session_id);
            grant.session_title = row.map(|r| r.0.clone());
            grant.project_id = row.and_then(|r| r.1.clone());
            grant.project_name = row.and_then(|r| r.2.clone());
        }
        if std::env::var("BUTLER_E2E_STORAGE_METRICS").as_deref() == Ok("1") {
            eprintln!(
                "approvals-profile authority_us={authority_us} metadata_us={metadata_us} application_us={}",
                started.elapsed().as_micros()
            );
        }
        Ok(grants)
    }
}

const METADATA_SQL: &str = "SELECT owners.value,c.title,c.project_id,p.display_name \
    FROM json_each(?1) owners \
    LEFT JOIN chats explicit INDEXED BY chats_runtime_hint_idx \
      ON explicit.runtime_session_hint=owners.value AND explicit.runtime_session_hint IS NOT NULL \
    LEFT JOIN chats legacy INDEXED BY sqlite_autoindex_chats_1 \
      ON explicit.id IS NULL AND legacy.runtime_session_hint IS NULL \
      AND legacy.id=CASE WHEN substr(owners.value,1,11)='butler/app-' THEN substr(owners.value,12) ELSE owners.value END \
    JOIN chats c INDEXED BY idx_chats_authority_metadata ON c.id=coalesce(explicit.id,legacy.id) \
    LEFT JOIN projects p INDEXED BY idx_projects_authority_metadata ON p.id=c.project_id";
