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
        let owners =
            serde_json::to_string(&owners).map_err(GatewayApplicationError::internal_from)?;
        let metadata = self
            .storage
            .read(move |db| {
                let started = std::time::Instant::now();
                // Stale one-chat statistics must not turn this batch into 600 table scans.
                let mut query = db.prepare_cached(
                "SELECT owner.value,c.title,c.project_id,p.display_name FROM json_each(?1) owner \
                 CROSS JOIN chats c INDEXED BY idx_chats_authority_metadata \
                 ON c.id=CASE WHEN substr(owner.value,1,11)='butler/app-' \
                 THEN substr(owner.value,12) ELSE owner.value END \
                 LEFT JOIN projects p INDEXED BY idx_projects_authority_metadata ON p.id=c.project_id"
            ).map_err(AppStorageError::sqlite)?;
                let metadata = query
                    .query_map([owners], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            (
                                row.get::<_, String>(1)?,
                                row.get::<_, Option<String>>(2)?,
                                row.get::<_, Option<String>>(3)?,
                            ),
                        ))
                    })
                    .map_err(AppStorageError::sqlite)?
                    .collect::<Result<HashMap<_, _>, _>>()
                    .map_err(AppStorageError::sqlite);
                if std::env::var("BUTLER_E2E_STORAGE_METRICS").as_deref() == Ok("1") {
                    eprintln!(
                        "approvals-profile metadata_sql_us={}",
                        started.elapsed().as_micros()
                    );
                }
                metadata
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
