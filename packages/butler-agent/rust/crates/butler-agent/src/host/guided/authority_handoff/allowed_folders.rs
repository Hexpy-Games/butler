use super::{
    AppAllowedFolder, ApplicationFuture, AuthorityHandoff, GatewayApplicationError,
    permission_error,
};
use butler_turn::btcc::PermissionRuleRow;
use butler_turn::workspace::{FolderRoots, allowed_folder};

impl AuthorityHandoff {
    pub(super) fn folders(&self) -> ApplicationFuture<Vec<AppAllowedFolder>> {
        let authority = self.authority.clone();
        Box::pin(async move {
            Ok(authority
                .list_permission_rules()
                .await
                .map_err(permission_error)?
                .into_iter()
                .filter(|row| row.kind == "folder")
                .map(|row| AppAllowedFolder {
                    rule_id: row.rule_id,
                    path: row.pattern,
                    created_at: row.created_at,
                })
                .collect())
        })
    }
    pub(super) fn add_folder(&self, path: String) -> ApplicationFuture<()> {
        let authority = self.authority.clone();
        let (data, installation) = self.folder_roots.clone();
        let now = self.now_iso.clone();
        Box::pin(async move {
            let protected = crate::host::service::data_reset::protected_roots(data.clone())
                .await
                .map_err(GatewayApplicationError::internal_from)?;
            let path = tokio::task::spawn_blocking(move || {
                allowed_folder(
                    &path,
                    &FolderRoots {
                        butler_data: &data,
                        installation_root: Some(&installation),
                        protected_roots: &protected,
                    },
                )
            })
            .await
            .map_err(GatewayApplicationError::internal_from)?
            .map_err(|refusal| GatewayApplicationError::Public {
                status: 400,
                code: refusal.code().into(),
                message: "This folder can't be added.".into(),
                source: None,
            })?;
            authority
                .add_permission_rule(PermissionRuleRow::new(
                    "allow",
                    "folder",
                    path.to_string_lossy().into_owned(),
                    None,
                    now(),
                ))
                .await
                .map_err(permission_error)
        })
    }
    pub(super) fn remove_folder(&self, rule_id: String) -> ApplicationFuture<()> {
        let authority = self.authority.clone();
        Box::pin(async move {
            authority
                .revoke_permission_rule(rule_id)
                .await
                .map_err(permission_error)
        })
    }
}
