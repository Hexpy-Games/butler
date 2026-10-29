use super::{
    Plugins, Result, State, capabilities, coverage, error, inspect, sources, storage, types::*,
};
use serde_json::{Value, json};
use std::{sync::Arc, time::Instant};

impl Plugins {
    pub(super) fn finish_check(
        &self,
        state: &mut State,
        id: &str,
        view: Result<Value>,
    ) -> Result<Value> {
        let old = state
            .registry
            .plugins
            .get(id)
            .cloned()
            .ok_or_else(|| error("plugin_not_found"))?;
        let result = view
            .and_then(|view| self.consider(state, id, &old, view))
            .unwrap_or_else(|e| json!({"id":id,"status":"error","error":e.code}));
        drop(old);
        *self.state.lock() = state.clone();
        self.collect_retired(state)?;
        state
            .checked
            .insert(id.to_owned(), (Instant::now(), result.clone()));
        Ok(result)
    }
    pub(super) fn check_source(
        &self,
        state: &mut State,
        old: &Installed,
        work: &std::path::Path,
    ) -> Result<Value> {
        let request = if let Some(pin) = &old.pin {
            if let Some(registry_id) = &pin.registry {
                let registry = state
                    .registry
                    .registries
                    .get(registry_id)
                    .ok_or_else(|| error("plugin_registry_not_found"))?;
                let fresh =
                    self.read_registry(&registry.url, registry.reference.as_deref(), work)?;
                // Refresh only the inspection snapshot; a failed check must not persist it.
                let mut snapshot = state.clone();
                snapshot
                    .registry
                    .registries
                    .insert(registry_id.clone(), fresh);
                let view = self.inspect_into(
                    &mut snapshot,
                    &json!({"registry":registry_id,"name":pin.name}),
                    work,
                )?;
                state.staging = snapshot.staging;
                return Ok(view);
            }
            json!({"git":pin.git,"ref":pin.reference,"commit":pin.requested_commit})
        } else {
            json!({"path":old.source})
        };
        self.inspect_into(state, &request, work)
    }
    fn consider(
        &self,
        state: &mut State,
        id: &str,
        old: &Installed,
        mut view: Value,
    ) -> Result<Value> {
        let staging_id = view["staging_id"]
            .as_str()
            .ok_or_else(|| error("plugin_staging_required"))?
            .to_owned();
        let inspection = state
            .staging
            .get(&staging_id)
            .cloned()
            .ok_or_else(|| error("plugin_staging_not_found"))?;
        if inspection.package.name != id {
            self.discard(state, &staging_id)?;
            return Err(error("plugin_update_name_mismatch"));
        }
        if inspection.digest == old.approval.content_digest {
            self.discard(state, &staging_id)?;
            self.clear_pending(state, id, old)?;
            return Ok(json!({"id":id,"status":"up_to_date","revision":state.registry.revision}));
        }
        let caps = capabilities::derive_capabilities(&inspection.package)?;
        let growth = coverage::uncovered(
            &old.approval.capabilities,
            &caps,
            &old.approval.hook_hashes,
            &coverage::hook_hashes(&inspection),
        );
        if !growth.is_empty() {
            view["uncovered"] = json!(growth);
            let mut next = state.registry.clone();
            let plugin = next
                .plugins
                .get_mut(id)
                .ok_or_else(|| error("plugin_not_found"))?;
            plugin.pending = Some(view.clone());
            plugin.pending_inspection = Some(inspection.clone());
            next.revision += 1;
            self.save(&next)?;
            state.registry = next;
            state.pending_stages.insert(staging_id.clone());
            if let Some(pending) = &old.pending_inspection {
                self.discard(state, &pending.staging_id)?;
            }
            return Ok(
                json!({"id":id,"status":"needs_review","pending":view,"revision":state.registry.revision}),
            );
        }
        self.swap(state, id, &inspection, caps)
    }
    pub(super) fn update(&self, id: Option<&str>, input: &Value) -> Result<Value> {
        let id = storage::id(id)?;
        let _mutation = self.mutation.lock();
        let mut state = self.state.lock().clone();
        storage::revision(&state, input)?;
        let old = state
            .registry
            .plugins
            .get(id)
            .ok_or_else(|| error("plugin_not_found"))?;
        let stage = input
            .get("staging_id")
            .and_then(Value::as_str)
            .ok_or_else(|| error("plugin_staging_required"))?;
        let inspection = state
            .staging
            .get(stage)
            .cloned()
            .ok_or_else(|| error("plugin_staging_not_found"))?;
        if inspection.package.name != id
            || old
                .pending
                .as_ref()
                .and_then(|v| v.get("staging_id"))
                .and_then(Value::as_str)
                != Some(stage)
        {
            return Err(error("plugin_update_invalid"));
        }
        if input.get("digest").and_then(Value::as_str) != Some(&inspection.digest) {
            return Err(error("plugin_digest_mismatch"));
        }
        let caps = capabilities::derive_capabilities(&inspection.package)?;
        let values = self.update_secrets(id, input, &caps)?;
        let saved = self.store_secrets(id, &values)?;
        let result = self.swap(&mut state, id, &inspection, caps);
        if result.is_err() {
            self.restore_secrets(&saved);
        }
        *self.state.lock() = state;
        result
    }
    fn update_secrets(
        &self,
        id: &str,
        input: &Value,
        caps: &CapabilitySet,
    ) -> Result<serde_json::Map<String, Value>> {
        let values = input
            .get("secrets")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        if values
            .keys()
            .any(|k| !caps.secrets.iter().any(|s| &s.key == k))
        {
            return Err(error("plugin_secret_fields_invalid"));
        }
        if caps.secrets.is_empty() {
            return Ok(values);
        }
        let secrets = storage::secret_store()?;
        for secret in &caps.secrets {
            if !values.get(&secret.key).is_some_and(Value::is_string)
                && secrets
                    .get(&storage::key(id, &secret.key)?)
                    .map_err(|_| error("plugin_secret_store_unavailable"))?
                    .is_none()
            {
                return Err(error("plugin_secret_fields_invalid"));
            }
        }
        Ok(values)
    }
    pub(super) fn swap(
        &self,
        state: &mut State,
        id: &str,
        inspection: &Inspection,
        caps: CapabilitySet,
    ) -> Result<Value> {
        let old = state
            .registry
            .plugins
            .get(id)
            .cloned()
            .ok_or_else(|| error("plugin_not_found"))?;
        let (mut installed, store, created) = self.prepare_store(inspection, caps)?;
        installed.enabled = old.enabled;
        let mut previous = old.clone();
        previous.previous = None;
        previous.pending = None;
        previous.pending_inspection = None;
        installed.previous = Some(Box::new(previous));
        let mut next = state.registry.clone();
        next.plugins.insert(id.to_owned(), installed);
        next.revision += 1;
        if let Err(e) = self.save(&next) {
            if created {
                let _ = butler_platform::plugin_files::remove(&store);
            }
            return Err(e);
        }
        state.registry = next;
        sources::track_plugin(&mut state.source_users, id, &old, false);
        if let Some(plugin) = state.registry.plugins.get(id) {
            sources::track_plugin(&mut state.source_users, id, plugin, true);
        }
        state.verified.remove(id);
        state.checked.remove(id);
        if let Some(previous) = &old.previous {
            if let Some(pin) = &previous.pin {
                self.cleanup_source(state, &pin.git)?;
            }
            state.retired.insert(
                previous.approval.content_digest.clone(),
                (id.to_owned(), Arc::downgrade(&previous.approval)),
            );
        }
        self.discard(state, &inspection.staging_id)?;
        if let Some(pending) = &old.pending_inspection
            && pending.staging_id != inspection.staging_id
        {
            self.discard(state, &pending.staging_id)?;
        }
        self.collect_retired(state)?;
        Ok(
            json!({"id":id,"status":"update_available","applied":true,"version":inspection.package.version,"previous_version":old.package.version,"revision":state.registry.revision}),
        )
    }
    fn prepare_store(
        &self,
        inspection: &Inspection,
        caps: CapabilitySet,
    ) -> Result<(Installed, std::path::PathBuf, bool)> {
        let stage = self.root.join("staging").join(&inspection.staging_id);
        let mut inspection = inspection.clone();
        let mut files = inspect::inventory(&stage, inspect::Limits::default())?;
        if inspection.pin.is_some() {
            sources::restore_modes(&mut files, &inspection.files);
        }
        if inspect::digest(&files) != inspection.digest {
            return Err(error("plugin_digest_mismatch"));
        }
        inspection.files = files;
        let store = self.root.join("store").join(&inspection.digest);
        let created = !store.exists();
        if created {
            std::fs::rename(&stage, &store).map_err(|_| error("plugin_store_failed"))?;
            butler_platform::plugin_files::protect(&store, true)
                .map_err(|_| error("plugin_store_failed"))?;
        } else {
            let mut existing = inspect::inventory(&store, inspect::Limits::default())?;
            if inspection.pin.is_some() {
                sources::restore_modes(&mut existing, &inspection.files);
            }
            if inspect::digest(&existing) != inspection.digest {
                return Err(error("changed_on_disk"));
            }
        }
        let mut installed = storage::approved(&inspection, caps);
        if !created {
            // Existing immutable content has its own filesystem timestamps.
            let mut files = inspect::inventory(&store, inspect::Limits::default())?;
            if inspection.pin.is_some() {
                sources::restore_modes(&mut files, &inspection.files);
            }
            installed.files = Arc::new(files);
        }
        Ok((installed, store, created))
    }
    pub(super) fn rollback(&self, id: Option<&str>, input: &Value) -> Result<Value> {
        let id = storage::id(id)?;
        let _mutation = self.mutation.lock();
        let mut state = self.state.lock().clone();
        storage::revision(&state, input)?;
        let old = state
            .registry
            .plugins
            .get(id)
            .cloned()
            .ok_or_else(|| error("plugin_not_found"))?;
        let mut previous = old
            .previous
            .as_deref()
            .cloned()
            .ok_or_else(|| error("plugin_previous_missing"))?;
        if !coverage::uncovered(
            &old.approval.capabilities,
            &previous.approval.capabilities,
            &old.approval.hook_hashes,
            &previous.approval.hook_hashes,
        )
        .is_empty()
        {
            return Err(error("plugin_rollback_needs_review"));
        }
        super::verify::files(
            &self
                .root
                .join("store")
                .join(&previous.approval.content_digest),
            &previous.files,
            true,
        )?;
        let mut current = old.clone();
        current.previous = None;
        current.pending = None;
        current.pending_inspection = None;
        previous.previous = Some(Box::new(current));
        previous.enabled = old.enabled;
        let version = previous.package.version.clone();
        let mut next = state.registry.clone();
        next.plugins.insert(id.to_owned(), previous);
        next.revision += 1;
        self.save(&next)?;
        state.registry = next;
        sources::track_plugin(&mut state.source_users, id, &old, false);
        if let Some(plugin) = state.registry.plugins.get(id) {
            sources::track_plugin(&mut state.source_users, id, plugin, true);
        }
        state.verified.remove(id);
        state.checked.remove(id);
        if let Some(pending) = &old.pending_inspection {
            self.discard(&mut state, &pending.staging_id)?;
        }
        *self.state.lock() = state.clone();
        Ok(
            json!({"id":id,"version":version,"previous_version":old.package.version,"revision":state.registry.revision}),
        )
    }
    fn clear_pending(&self, state: &mut State, id: &str, old: &Installed) -> Result<()> {
        if let Some(pending) = &old.pending_inspection {
            let mut next = state.registry.clone();
            let plugin = next
                .plugins
                .get_mut(id)
                .ok_or_else(|| error("plugin_not_found"))?;
            plugin.pending = None;
            plugin.pending_inspection = None;
            next.revision += 1;
            self.save(&next)?;
            state.registry = next;
            self.discard(state, &pending.staging_id)?;
        }
        Ok(())
    }
    pub(super) fn discard(&self, state: &mut State, stage: &str) -> Result<()> {
        state.staging.remove(stage);
        state.pending_stages.remove(stage);
        butler_platform::plugin_files::remove(&self.root.join("staging").join(stage))
            .map_err(|_| error("plugin_staging_cleanup_failed"))
    }
    fn collect_retired(&self, state: &mut State) -> Result<()> {
        let dead = state
            .retired
            .iter()
            .filter(|(digest, (id, weak))| {
                weak.strong_count() == 0
                    && !state.registry.plugins.get(id).is_some_and(|p| {
                        &p.approval.content_digest == *digest
                            || p.previous
                                .as_ref()
                                .is_some_and(|p| &p.approval.content_digest == *digest)
                    })
            })
            .map(|(d, _)| d.clone())
            .collect::<Vec<_>>();
        for digest in dead {
            butler_platform::plugin_files::remove(&self.root.join("store").join(&digest))
                .map_err(|_| error("plugin_store_cleanup_failed"))?;
            state.retired.remove(&digest);
        }
        Ok(())
    }
    pub(super) fn cleanup_removed(&self, state: &mut State, plugin: &Installed) -> Result<()> {
        if let Some(previous) = &plugin.previous {
            butler_platform::plugin_files::remove(
                &self
                    .root
                    .join("store")
                    .join(&previous.approval.content_digest),
            )
            .map_err(|_| error("plugin_store_cleanup_failed"))?;
        }
        sources::track_plugin(&mut state.source_users, &plugin.package.name, plugin, false);
        for version in std::iter::once(plugin).chain(plugin.previous.as_deref()) {
            if let Some(pin) = &version.pin {
                self.cleanup_source(state, &pin.git)?;
            }
        }
        if let Some(pending) = &plugin.pending_inspection {
            self.discard(state, &pending.staging_id)?;
        }
        state.checked.remove(&plugin.package.name);
        self.collect_retired(state)
    }
}
