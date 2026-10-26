//! Source preparation owns private disk state and never holds admin write locks.
use super::{Plugins, Result, State, error, sources, storage, types::*};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};

enum Prepared {
    Inspection(Value),
    Check(Result<Value>),
    Registry(TeamRegistry),
}

struct Work(PathBuf);
impl Drop for Work {
    fn drop(&mut self) {
        let _ = butler_platform::plugin_files::remove(&self.0);
    }
}

impl Plugins {
    pub(super) fn source_action(
        &self,
        action: &str,
        id: Option<&str>,
        input: &Value,
    ) -> Result<Value> {
        let runtime = tokio::runtime::Handle::current();
        let mut snapshot = {
            let _permit = runtime.block_on(self.writes.acquire_owned());
            let _mutation = self.mutation.lock();
            self.state.lock().clone()
        };
        if action != "inspect" && (action != "check" || input.get("revision").is_some()) {
            storage::revision(&snapshot, input)?;
        }
        if action == "check" {
            let id = storage::id(id)?;
            if !snapshot.registry.plugins.contains_key(id) {
                return Err(error("plugin_not_found"));
            }
            if input.get("force").and_then(Value::as_bool) != Some(true)
                && let Some((time, result)) = snapshot.checked.get(id)
                && time.elapsed() < Duration::from_hours(6)
            {
                return Ok(result.clone());
            }
        }
        snapshot.staging.clear();
        let work = Work(
            self.root
                .join("work")
                .join(uuid::Uuid::new_v4().to_string()),
        );
        butler_platform::secure_fs::create_private_dir_all(&work.0)
            .map_err(|_| error("plugin_copy_failed"))?;
        let prepared = self.prepare_source(action, id, input, &mut snapshot, &work.0)?;
        self.commit_source(action, id, input, snapshot, &work.0, prepared)
    }

    fn commit_source(
        &self,
        action: &str,
        id: Option<&str>,
        input: &Value,
        mut snapshot: State,
        work: &Path,
        prepared: Prepared,
    ) -> Result<Value> {
        let revision = snapshot.registry.revision;
        let staging = std::mem::take(&mut snapshot.staging);
        drop(snapshot);
        let _permit = tokio::runtime::Handle::current().block_on(self.writes.acquire_owned());
        let mutation = self.mutation.lock();
        let mut state = self.state.lock().clone();
        storage::revision(&state, &json!({"revision":revision}))?;
        if matches!(prepared, Prepared::Inspection(_)) {
            self.clear_unclaimed_staging(&mut state)?;
        }
        publish_sources(&self.root, work)?;
        for (id, inspection) in staging {
            butler_platform::secure_fs::create_private_dir_all(&self.root.join("staging"))
                .map_err(|_| error("plugin_copy_failed"))?;
            std::fs::rename(
                work.join("staging").join(&id),
                self.root.join("staging").join(&id),
            )
            .map_err(|_| error("plugin_copy_failed"))?;
            state.staging.insert(id, inspection);
        }
        let result = match prepared {
            Prepared::Inspection(view) => Ok(view),
            Prepared::Check(view) => self.finish_check(&mut state, storage::id(id)?, view),
            Prepared::Registry(registry) => {
                // registry_action takes the mutation lock itself.
                drop(mutation);
                return self.registry_action(action, id, input, Some(registry));
            }
        };
        *self.state.lock() = state;
        result
    }

    fn prepare_source(
        &self,
        action: &str,
        id: Option<&str>,
        input: &Value,
        snapshot: &mut State,
        work: &Path,
    ) -> Result<Prepared> {
        match action {
            "inspect" => Ok(Prepared::Inspection(
                self.inspect_into(snapshot, input, work)?,
            )),
            "check" => {
                let old = snapshot
                    .registry
                    .plugins
                    .get(storage::id(id)?)
                    .cloned()
                    .ok_or_else(|| error("plugin_not_found"))?;
                Ok(Prepared::Check(self.check_source(snapshot, &old, work)))
            }
            "registry_add" => {
                let url = sources::url(
                    input
                        .get("url")
                        .and_then(Value::as_str)
                        .ok_or_else(|| error("plugin_git_url_invalid"))?,
                )?;
                if snapshot
                    .registry
                    .registries
                    .contains_key(&sources::hash(&url))
                {
                    return Err(error("plugin_registry_exists"));
                }
                Ok(Prepared::Registry(self.read_registry(
                    &url,
                    input.get("ref").and_then(Value::as_str),
                    work,
                )?))
            }
            "registry_refresh" => {
                let old = id
                    .and_then(|id| snapshot.registry.registries.get(id))
                    .ok_or_else(|| error("plugin_registry_not_found"))?;
                Ok(Prepared::Registry(self.read_registry(
                    &old.url,
                    old.reference.as_deref(),
                    work,
                )?))
            }
            _ => Err(error("plugin_action_invalid")),
        }
    }
}

fn publish_sources(root: &Path, work: &Path) -> Result<()> {
    let sources = work.join("sources");
    if !sources.exists() {
        return Ok(());
    }
    butler_platform::secure_fs::create_private_dir_all(&root.join("sources"))
        .map_err(|_| error("plugin_git_failed"))?;
    butler_platform::secure_fs::create_private_dir_all(&work.join("retired"))
        .map_err(|_| error("plugin_git_failed"))?;
    for entry in std::fs::read_dir(sources).map_err(|_| error("plugin_git_failed"))? {
        let entry = entry.map_err(|_| error("plugin_git_failed"))?;
        let target = root.join("sources").join(entry.file_name());
        if target.exists() {
            std::fs::rename(&target, work.join("retired").join(entry.file_name()))
                .map_err(|_| error("plugin_git_failed"))?;
        }
        std::fs::rename(entry.path(), target).map_err(|_| error("plugin_git_failed"))?;
    }
    Ok(())
}
