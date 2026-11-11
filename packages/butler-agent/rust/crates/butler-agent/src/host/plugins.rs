//! Consent-bound local packages. No discovery, background jobs or startup spawns.
mod capabilities;
mod connector_manifest;
mod connectors;
mod coverage;
mod git_process;
mod inspect;
mod inspection;
mod manifest;
mod overlay;
mod registries;
pub(crate) mod safe_mode;
mod secret_cleanup;
mod source_work;
mod sources;
mod storage;
mod types;
mod updates;
mod verify;
use butler_core::{
    configuration::ConfigurationWrites,
    plugins::{PluginError, PluginFuture, PluginPort},
};
use parking_lot::Mutex;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::PathBuf,
    sync::Arc,
};
use types::*;
type Result<T> = std::result::Result<T, PluginError>;
fn error(code: &'static str) -> PluginError {
    PluginError { status: 400, code }
}
#[derive(Clone)]
struct State {
    registry: Registry,
    staging: BTreeMap<String, Arc<Inspection>>,
    verified: BTreeSet<String>,
    pending_stages: BTreeSet<String>,
    checked: BTreeMap<String, (std::time::Instant, Value)>,
    retired: BTreeMap<String, (String, std::sync::Weak<Approval>)>,
    source_users: BTreeMap<String, BTreeSet<String>>,
}
pub(crate) struct Plugins {
    connectors: Arc<connectors::Connectors>,
    authority: std::sync::OnceLock<Arc<butler_turn::btcc::PrincipalAuthority>>,
    root: PathBuf,
    safe_mode: bool,
    state: Mutex<State>,
    mutation: Mutex<()>,
    writes: Arc<ConfigurationWrites>,
}
impl Plugins {
    pub(crate) async fn open(
        data: PathBuf,
        safe_mode: bool,
        writes: Arc<ConfigurationWrites>,
    ) -> Result<Arc<Self>> {
        tokio::task::spawn_blocking(move || {
            let safe_mode = safe_mode::take(&data)? || safe_mode;
            let root = data.join("plugins");
            let registry = match std::fs::read(root.join("registry.json")) {
                Ok(bytes) => {
                    serde_json::from_slice(&bytes).map_err(|_| error("plugin_registry_invalid"))?
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Registry::default(),
                Err(_) => return Err(error("plugin_registry_unreadable")),
            };
            storage::recover(&root, &registry)?;
            let source_users = sources::users(&registry);
            let staging: BTreeMap<_, _> = registry
                .plugins
                .values()
                .filter_map(|p| p.pending_inspection.clone())
                .map(|i| (i.staging_id.clone(), i))
                .collect();
            Ok(Arc::new_cyclic(|weak| Self {
                connectors: connectors::Connectors::new(weak.clone()),
                authority: std::sync::OnceLock::new(),
                root,
                safe_mode,
                mutation: Mutex::new(()),
                state: Mutex::new(State {
                    registry,
                    pending_stages: staging.keys().cloned().collect(),
                    staging,
                    verified: BTreeSet::new(),
                    checked: BTreeMap::new(),
                    retired: BTreeMap::new(),
                    source_users,
                }),
                writes,
            }))
        })
        .await
        .map_err(|_| error("plugin_task_failed"))?
    }
    pub(crate) fn set_authority(&self, authority: Arc<butler_turn::btcc::PrincipalAuthority>) {
        let _ = self.authority.set(authority);
    }
    async fn revoke_grants(&self, id: Option<&str>, input: &Value) -> Result<()> {
        let id = id.ok_or_else(|| error("plugin_id_invalid"))?;
        {
            let state = self.state.lock();
            if input.get("revision").and_then(Value::as_u64) != Some(state.registry.revision) {
                return Err(PluginError {
                    status: 409,
                    code: "plugin_revision_conflict",
                });
            }
            if !state.registry.plugins.contains_key(id) {
                return Err(error("plugin_not_found"));
            }
        }
        let authority = self
            .authority
            .get()
            .ok_or_else(|| error("plugin_authority_unavailable"))?;
        let prefix = format!("mcp:{id}/");
        let grants = authority
            .list_all_permissions()
            .await
            .map_err(|_| error("plugin_grant_revoke_failed"))?;
        let grants = grants
            .into_iter()
            .filter(|p| p.capability == "call_mcp_tool" && p.target.starts_with(&prefix))
            .map(|p| (p.owner_session_id, p.grant_ref))
            .collect();
        authority
            .revoke_permissions(grants)
            .await
            .map_err(|_| error("plugin_grant_revoke_failed"))
    }
    fn inventory(&self) -> Value {
        let state = self.state.lock();
        let plugins = state.registry.plugins.iter().map(|(id, p)| json!({
            "id": id, "version": p.package.version, "author": p.package.author,
            "publisher_verified": false, "source": p.source, "enabled": p.enabled,
            "quarantine": p.quarantine, "content_digest": p.approval.content_digest,
            "capabilities": p.approval.capabilities, "compatibility": p.package.compatibility,
            "pin":p.pin,"source_kind":p.source_kind,"listed_in":p.listed_in,"pending":p.pending,
            "state":if p.pending.is_some(){"needs_review"}else{"installed"},
        })).collect::<Vec<_>>();
        json!({"plugins":plugins,"revision":state.registry.revision,"safe_mode":self.safe_mode})
    }
    fn save(&self, registry: &Registry) -> Result<()> {
        butler_core::configuration::write_json_atomic(
            &self.root.join("registry.json"),
            &serde_json::to_value(registry).map_err(|_| error("plugin_registry_invalid"))?,
        )
        .map_err(|_| error("plugin_registry_write_failed"))
    }
}
pub(crate) struct Admin(pub Arc<Plugins>);
impl PluginPort for Admin {
    fn bind_connector_store(&self, store: butler_core::plugins::ConnectorStoreRef) {
        self.0.connectors.bind(store);
    }
    fn safe_mode(&self) -> bool {
        self.0.safe_mode
    }
    fn list(&self) -> PluginFuture<'_> {
        Box::pin(async { Ok(self.0.inventory()) })
    }
    fn execute(&self, action: String, id: Option<String>, input: Value) -> PluginFuture<'_> {
        let owner = self.0.clone();
        Box::pin(async move {
            if action.starts_with("connector") {
                return owner.connectors.admin(&action, id, input).await;
            }
            let runtime = owner.connectors.clone();
            let changed_action = action.clone();
            let changed_id = id.clone();
            let result = if matches!(
                action.as_str(),
                "inspect" | "check" | "registry_add" | "registry_refresh"
            ) {
                // Source work runs outside the admin locks (network I/O).
                tokio::task::spawn_blocking(move || {
                    owner.source_action(&action, id.as_deref(), &input)
                })
                .await
                .map_err(|_| error("plugin_task_failed"))?
            } else {
                let permit = owner.writes.acquire_owned().await;
                if action == "uninstall" {
                    owner.revoke_grants(id.as_deref(), &input).await?;
                    owner.connectors.stop_plugin(id.as_deref()).await;
                }
                tokio::task::spawn_blocking(move || {
                    let _permit = permit;
                    match action.as_str() {
                        "install" => owner.install(&input),
                        "update" => owner.update(id.as_deref(), &input),
                        "rollback" => owner.rollback(id.as_deref(), &input),
                        "registry_list" | "registry_delete" => {
                            owner.registry_action(&action, id.as_deref(), &input, None)
                        }
                        "enable" | "disable" => {
                            owner.toggle(id.as_deref(), &input, action == "enable")
                        }
                        "uninstall" => owner.uninstall(id.as_deref(), &input),
                        _ => Err(error("plugin_action_invalid")),
                    }
                })
                .await
                .map_err(|_| error("plugin_task_failed"))?
            };
            if result.is_ok() {
                runtime
                    .plugin_changed(&changed_action, changed_id.as_deref())
                    .await;
                runtime.reconcile().await;
            }
            result
        })
    }
}
