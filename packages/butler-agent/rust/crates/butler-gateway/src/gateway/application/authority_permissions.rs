use super::{AppApplication, AppGrantRef, AppGrantView, app_error, storage::AppStorageError};
use crate::gateway::ApplicationFuture;
use crate::gateway::{GatewayApplication, GatewayApplicationError};
use rusqlite::OptionalExtension;

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
        let mut grants = self
            .dependencies
            .authority_handoff
            .list_all_permissions()
            .await?;
        let owners: std::collections::HashSet<_> =
            grants.iter().map(|g| g.session_id.clone()).collect();
        let metadata = self.storage.read(move |db| {
            let mut metadata = HashMap::new();
            let mut query = db.prepare_cached("SELECT c.title,c.project_id,p.display_name FROM chats c LEFT JOIN projects p ON p.id=c.project_id WHERE c.id=?1")
                .map_err(AppStorageError::sqlite)?;
            for owner in owners {
                let row = query.query_row([owner.strip_prefix("butler/app-").unwrap_or(&owner)], |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?, row.get::<_, Option<String>>(2)?)))
                    .optional().map_err(AppStorageError::sqlite)?;
                metadata.insert(owner, row);
            }
            Ok(metadata)
        }).await.map_err(app_error)?;
        for grant in &mut grants {
            let row = metadata.get(&grant.session_id).and_then(Option::as_ref);
            grant.session_title = row.map(|r| r.0.clone());
            grant.project_id = row.and_then(|r| r.1.clone());
            grant.project_name = row.and_then(|r| r.2.clone());
        }
        Ok(grants)
    }
}
