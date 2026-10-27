use super::{Plugins, Result, State, error, inspect, types::*};
use butler_platform::secrets::SecretKey;
use serde_json::{Value, json};
use std::{fs, path::Path};

pub(super) fn clear_staging(root: &Path) -> Result<()> {
    let staging = root.join("staging");
    if staging.exists() {
        fs::remove_dir_all(staging).map_err(|_| error("plugin_staging_cleanup_failed"))?;
    }
    Ok(())
}
/// Reclaim abandoned snapshots once at startup, when no operation holds a lease.
pub(super) fn recover(root: &Path, registry: &Registry) -> Result<()> {
    butler_platform::plugin_files::remove(&root.join("work"))
        .map_err(|_| error("plugin_staging_cleanup_failed"))?;
    let mut stores = std::collections::BTreeSet::new();
    let mut stages = std::collections::BTreeSet::new();
    for plugin in registry.plugins.values() {
        stores.insert(plugin.approval.content_digest.as_str());
        if let Some(previous) = &plugin.previous {
            stores.insert(previous.approval.content_digest.as_str());
        }
        if let Some(pending) = &plugin.pending_inspection {
            stages.insert(pending.staging_id.as_str());
        }
    }
    for (directory, retained) in [("store", stores), ("staging", stages)] {
        let entries = match fs::read_dir(root.join(directory)) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return Err(error("plugin_store_cleanup_failed")),
        };
        for entry in entries {
            let entry = entry.map_err(|_| error("plugin_store_cleanup_failed"))?;
            if !entry
                .file_name()
                .to_str()
                .is_some_and(|name| retained.contains(name))
            {
                butler_platform::plugin_files::remove(&entry.path())
                    .map_err(|_| error("plugin_store_cleanup_failed"))?;
            }
        }
    }
    Ok(())
}
pub(super) fn secret_store() -> Result<butler_platform::secrets::SecretStore> {
    butler_platform::secrets::SecretStore::system()
        .map_err(|_| error("plugin_secret_store_unavailable"))
}
pub(super) fn key(id: &str, field: &str) -> Result<SecretKey> {
    SecretKey::new(
        "io.github.hexpy-games.butler.plugins",
        &format!("{id}/{field}"),
    )
    .map_err(|_| error("plugin_secret_key_invalid"))
}
pub(super) fn revision(state: &State, input: &Value) -> Result<()> {
    if input.get("revision").and_then(Value::as_u64) != Some(state.registry.revision) {
        return Err(butler_core::plugins::PluginError {
            status: 409,
            code: "plugin_revision_conflict",
        });
    }
    Ok(())
}
pub(super) fn id(input: Option<&str>) -> Result<&str> {
    input
        .filter(|s| super::manifest::valid_id(s))
        .ok_or_else(|| error("plugin_id_invalid"))
}
impl Plugins {
    pub(super) fn install(&self, input: &Value) -> Result<Value> {
        let _mutation = self.mutation.lock();
        let mut state = self.state.lock().clone();
        revision(&state, input)?;
        if state.staging.is_empty() {
            clear_staging(&self.root)?;
        }
        let staging_id = input
            .get("staging_id")
            .and_then(Value::as_str)
            .ok_or_else(|| error("plugin_staging_required"))?;
        let mut inspection = state
            .staging
            .get(staging_id)
            .map(|inspection| inspection.as_ref().clone())
            .ok_or_else(|| error("plugin_staging_not_found"))?;
        if input.get("digest").and_then(Value::as_str) != Some(&inspection.digest) {
            return Err(error("plugin_digest_mismatch"));
        }
        if state
            .registry
            .plugins
            .contains_key(&inspection.package.name)
        {
            return Err(error("plugin_already_installed"));
        }
        let stage = self.root.join("staging").join(staging_id);
        let mut files = inspect::inventory(&stage, inspect::Limits::default())?;
        if inspection.pin.is_some() {
            super::sources::restore_modes(&mut files, &inspection.files);
        }
        if inspect::digest(&files) != inspection.digest {
            return Err(error("plugin_digest_mismatch"));
        }
        inspection.files = files;
        let caps = super::capabilities::derive_capabilities(&inspection.package)?;
        let values = install_secrets(input, &caps)?;
        let store = self.root.join("store").join(&inspection.digest);
        fs::create_dir_all(self.root.join("store")).map_err(|_| error("plugin_store_failed"))?;
        if store.exists() {
            return Err(error("plugin_store_exists"));
        }
        let saved = self.store_secrets(&inspection.package.name, &values)?;
        let mut next = state.registry.clone();
        next.plugins
            .insert(inspection.package.name.clone(), approved(&inspection, caps));
        next.revision += 1;
        let result = (|| {
            fs::rename(&stage, &store).map_err(|_| error("plugin_store_failed"))?;
            butler_platform::plugin_files::protect(&store, true)
                .map_err(|_| error("plugin_store_failed"))?;
            butler_platform::secure_fs::create_private_dir_all(
                &self.root.join("data").join(&inspection.package.name),
            )
            .map_err(|_| error("plugin_data_failed"))?;
            self.save(&next)
        })();
        if let Err(e) = result {
            let _ = butler_platform::plugin_files::remove(&store);
            self.restore_secrets(&saved);
            return Err(e);
        }
        state.registry = next;
        if let Some(pin) = &inspection.pin {
            super::sources::track(
                &mut state.source_users,
                &pin.git,
                &format!("plugin:{}", inspection.package.name),
                true,
            );
        }
        *self.state.lock() = state.clone();
        state.staging.remove(staging_id);
        *self.state.lock() = state.clone();
        Ok(json!({"id":inspection.package.name,"revision":state.registry.revision}))
    }
    pub(super) fn store_secrets(
        &self,
        id: &str,
        values: &serde_json::Map<String, Value>,
    ) -> Result<Vec<(SecretKey, Option<butler_platform::secrets::SecretText>)>> {
        for value in values.values().filter_map(Value::as_str) {
            butler_log::register_secret(value);
        }
        if values.is_empty() {
            return Ok(Vec::new());
        }
        let secrets = secret_store()?;
        let saved = values
            .keys()
            .map(|field| {
                let key = key(id, field)?;
                let old = secrets
                    .get(&key)
                    .map_err(|_| error("plugin_secret_store_unavailable"))?;
                Ok((key, old))
            })
            .collect::<Result<Vec<_>>>()?;
        for ((key, _), value) in saved.iter().zip(values.values()) {
            if secrets
                .set(
                    key,
                    value
                        .as_str()
                        .ok_or_else(|| error("plugin_secret_fields_invalid"))?,
                )
                .is_err()
            {
                self.restore_secrets(&saved);
                return Err(error("plugin_secret_store_unavailable"));
            }
        }
        Ok(saved)
    }
    pub(super) fn restore_secrets(
        &self,
        saved: &[(SecretKey, Option<butler_platform::secrets::SecretText>)],
    ) {
        if saved.is_empty() {
            return;
        }
        let Ok(secrets) = secret_store() else {
            return;
        };
        for (key, value) in saved {
            match value {
                Some(v) => {
                    let _ = secrets.set(key, v.expose());
                }
                None => {
                    let _ = secrets.delete(key);
                }
            }
        }
    }
    pub(super) fn toggle(
        &self,
        plugin_id: Option<&str>,
        input: &Value,
        enabled: bool,
    ) -> Result<Value> {
        let id = id(plugin_id)?;
        let _mutation = self.mutation.lock();
        let mut state = self.state.lock().clone();
        revision(&state, input)?;
        let mut next = state.registry.clone();
        let plugin = next
            .plugins
            .get_mut(id)
            .ok_or_else(|| error("plugin_not_found"))?;
        if enabled && plugin.quarantine.is_some() {
            return Err(error("plugin_quarantined"));
        }
        plugin.enabled = enabled;
        next.revision += 1;
        self.save(&next)?;
        state.registry = next;
        *self.state.lock() = state.clone();
        Ok(json!({"id":id,"enabled":enabled,"revision":state.registry.revision}))
    }
    pub(super) fn uninstall(&self, plugin_id: Option<&str>, input: &Value) -> Result<Value> {
        let id = id(plugin_id)?;
        let _mutation = self.mutation.lock();
        let mut state = self.state.lock().clone();
        revision(&state, input)?;
        let mut next = state.registry.clone();
        let plugin = next
            .plugins
            .remove(id)
            .ok_or_else(|| error("plugin_not_found"))?;
        let connector_keys = next
            .accounts
            .values()
            .filter(|a| a.plugin == id)
            .map(|a| self.connectors.secret_keys(a))
            .collect::<Result<Vec<_>>>()?
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();
        next.accounts.retain(|_, account| account.plugin != id);
        next.revision += 1;
        self.save(&next)?;
        state.registry = next;
        *self.state.lock() = state.clone();
        state.verified.remove(id);
        *self.state.lock() = state.clone();
        butler_platform::plugin_files::remove(
            &self
                .root
                .join("store")
                .join(&plugin.approval.content_digest),
        )
        .map_err(|_| error("plugin_store_cleanup_failed"))?;
        self.cleanup_removed(&mut state, &plugin)?;
        *self.state.lock() = state.clone();
        let mut leftovers = super::secret_cleanup::system(&connector_keys);
        if input.get("data") == Some(&Value::Bool(true)) {
            let data = self.root.join("data").join(id);
            if data.exists() {
                fs::remove_dir_all(data).map_err(|_| error("plugin_data_cleanup_failed"))?;
            }
            let keys = plugin
                .approval
                .capabilities
                .secrets
                .iter()
                .map(|field| key(id, &field.key))
                .collect::<Result<Vec<_>>>()?;
            leftovers.extend(super::secret_cleanup::system(&keys));
        }
        let mut response = json!({"id":id,"revision":state.registry.revision});
        super::secret_cleanup::report(&mut response, &leftovers);
        Ok(response)
    }
}

pub(super) fn approved(inspection: &Inspection, caps: CapabilitySet) -> Installed {
    let approval = Approval {
        content_digest: inspection.digest.clone(),
        capabilities: caps,
        hook_hashes: super::coverage::hook_hashes(inspection),
        approved_at: chrono::Utc::now().to_rfc3339(),
    };
    Installed {
        package: std::sync::Arc::new(inspection.package.clone()),
        source: inspection.source.clone(),
        source_kind: source_kind(inspection.pin.as_ref()).into(),
        approval: std::sync::Arc::new(approval),
        files: std::sync::Arc::new(inspection.files.clone()),
        enabled: true,
        quarantine: None,
        pin: inspection.pin.clone(),
        listed_in: inspection.listed_in.clone(),
        previous: None,
        pending: None,
        pending_inspection: None,
    }
}

fn install_secrets(input: &Value, caps: &CapabilitySet) -> Result<serde_json::Map<String, Value>> {
    let values = input
        .get("secrets")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if values
        .keys()
        .any(|k| !caps.secrets.iter().any(|f| &f.key == k))
        || caps
            .secrets
            .iter()
            .any(|f| values.get(&f.key).and_then(Value::as_str).is_none())
    {
        return Err(error("plugin_secret_fields_invalid"));
    }
    Ok(values)
}
