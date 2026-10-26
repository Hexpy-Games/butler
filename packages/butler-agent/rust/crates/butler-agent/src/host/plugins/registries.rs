use super::{Plugins, Result, State, error, sources, storage, types::*};
use serde_json::{Value, json};
use std::collections::BTreeSet;

impl Plugins {
    pub(super) fn registry_action(
        &self,
        action: &str,
        id: Option<&str>,
        input: &Value,
        prepared: Option<TeamRegistry>,
    ) -> Result<Value> {
        let _mutation = self.mutation.lock();
        let mut state = self.state.lock().clone();
        if action == "registry_list" {
            return Ok(
                json!({"registries":state.registry.registries,"revision":state.registry.revision}),
            );
        }
        storage::revision(&state, input)?;
        let mut next = state.registry.clone();
        let old = id.and_then(|id| next.registries.get(id)).cloned();
        let id = match action {
            "registry_add" => {
                let url = sources::url(
                    input
                        .get("url")
                        .and_then(Value::as_str)
                        .ok_or_else(|| error("plugin_git_url_invalid"))?,
                )?;
                let id = sources::hash(&url);
                if next.registries.contains_key(&id) {
                    return Err(error("plugin_registry_exists"));
                }
                let registry = prepared.ok_or_else(|| error("plugin_registry_invalid"))?;
                next.registries.insert(id.clone(), registry);
                id
            }
            "registry_refresh" => {
                let id = id.ok_or_else(|| error("plugin_registry_not_found"))?;
                if !next.registries.contains_key(id) {
                    return Err(error("plugin_registry_not_found"));
                }
                let registry = prepared.ok_or_else(|| error("plugin_registry_invalid"))?;
                next.registries.insert(id.to_owned(), registry);
                id.to_owned()
            }
            "registry_delete" => {
                let id = id.ok_or_else(|| error("plugin_registry_not_found"))?;
                let old = next
                    .registries
                    .remove(id)
                    .ok_or_else(|| error("plugin_registry_not_found"))?;
                next.revision += 1;
                self.save(&next)?;
                state.registry = next;
                sources::track_registry(&mut state.source_users, id, &old, false);
                *self.state.lock() = state.clone();
                self.cleanup_registry_sources(&state, &old)?;
                return Ok(json!({"id":id,"revision":state.registry.revision}));
            }
            _ => return Err(error("plugin_action_invalid")),
        };
        next.revision += 1;
        self.save(&next)?;
        if let Some(old) = &old {
            sources::track_registry(&mut state.source_users, &id, old, false);
        }
        if let Some(new) = next.registries.get(&id) {
            sources::track_registry(&mut state.source_users, &id, new, true);
        }
        state.registry = next;
        *self.state.lock() = state.clone();
        if let Some(old) = &old {
            self.cleanup_registry_sources(&state, old)?;
        }
        Ok(
            json!({"id":id,"registry":state.registry.registries.get(&id),"revision":state.registry.revision}),
        )
    }
    pub(super) fn read_registry(
        &self,
        url: &str,
        reference: Option<&str>,
        work: &std::path::Path,
    ) -> Result<TeamRegistry> {
        let (root, commit) = sources::checkout(work, url, reference, None)?;
        sources::modes(&root)?;
        let file = butler_platform::secure_fs::open_package_file(
            &root,
            std::path::Path::new("butler-registry.json"),
        )
        .map_err(|_| error("plugin_registry_invalid"))?;
        if file
            .metadata()
            .map_err(|_| error("plugin_registry_invalid"))?
            .len()
            > 1024 * 1024
        {
            return Err(error("plugin_registry_invalid"));
        }
        let mut bytes = Vec::new();
        std::io::Read::read_to_end(&mut std::io::Read::take(file, 1024 * 1024 + 1), &mut bytes)
            .map_err(|_| error("plugin_registry_invalid"))?;
        let value: Value =
            serde_json::from_slice(&bytes).map_err(|_| error("plugin_registry_invalid"))?;
        let mut entries: Vec<RegistryEntry> =
            serde_json::from_value(value.get("plugins").cloned().unwrap_or(value))
                .map_err(|_| error("plugin_registry_invalid"))?;
        let mut names = BTreeSet::new();
        for entry in &mut entries {
            if !super::manifest::valid_id(&entry.name)
                || !names.insert(&entry.name)
                || entry.reference.is_some() && entry.commit.is_some()
                || entry.commit.as_ref().is_some_and(|s| {
                    !matches!(s.len(), 40 | 64) || !s.bytes().all(|c| c.is_ascii_hexdigit())
                })
                || entry
                    .digest
                    .as_ref()
                    .is_some_and(|s| s.len() != 64 || !s.bytes().all(|c| c.is_ascii_hexdigit()))
            {
                return Err(error("plugin_registry_invalid"));
            }
            entry.git = sources::url(&entry.git)?;
        }
        Ok(TeamRegistry {
            url: url.to_owned(),
            reference: reference.map(str::to_owned),
            commit,
            entries: entries
                .into_iter()
                .map(|entry| (entry.name.clone(), entry))
                .collect(),
        })
    }
    fn cleanup_registry_sources(&self, state: &State, registry: &TeamRegistry) -> Result<()> {
        self.cleanup_source(state, &registry.url)?;
        for entry in registry.entries.values() {
            self.cleanup_source(state, &entry.git)?;
        }
        Ok(())
    }
    pub(super) fn cleanup_source(&self, state: &State, url: &str) -> Result<()> {
        let used = state
            .source_users
            .get(url)
            .is_some_and(|users| !users.is_empty());
        if !used {
            butler_platform::plugin_files::remove(
                &self.root.join("sources").join(sources::hash(url)),
            )
            .map_err(|_| error("plugin_source_cleanup_failed"))?;
        }
        Ok(())
    }
}
