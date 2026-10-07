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
            .read(move |db| {
                let started = std::time::Instant::now();
                // Stale one-chat statistics must not turn this batch into 600 table scans.
                let mut metadata = HashMap::new();
                let mut query = db
                    .prepare_cached(
                        "SELECT c.title,c.project_id,p.display_name FROM chats c INDEXED BY idx_chats_authority_metadata \
                     LEFT JOIN projects p INDEXED BY idx_projects_authority_metadata ON p.id=c.project_id WHERE c.id=?1",
                    )
                    .map_err(AppStorageError::sqlite)?;
                for owner in owners {
                    if let Some(chat) = super::sessions::identity::resolve_owner(db, &owner)? {
                        let row = query
                            .query_row([chat], |row| {
                                Ok((
                                    row.get::<_, String>(0)?,
                                    row.get::<_, Option<String>>(1)?,
                                    row.get::<_, Option<String>>(2)?,
                                ))
                            })
                            .map_err(AppStorageError::sqlite)?;
                        metadata.insert(owner, row);
                    }
                }
                if std::env::var("BUTLER_E2E_STORAGE_METRICS").as_deref() == Ok("1") {
                    eprintln!(
                        "approvals-profile metadata_sql_us={}",
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
