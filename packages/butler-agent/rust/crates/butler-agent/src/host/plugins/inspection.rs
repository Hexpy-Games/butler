use super::{
    Plugins, Result, State, capabilities, error, inspect, manifest, overlay, sources, types::*,
};
use serde_json::{Value, json};
use std::{path::PathBuf, sync::Arc};

type RegistryRequest = (Value, Option<Value>, Option<String>, Option<String>);
type ResolvedSource = (PathBuf, Option<SourcePin>, Option<Value>, Option<String>);
impl Plugins {
    pub(super) fn clear_unclaimed_staging(&self, state: &mut State) -> Result<()> {
        let stale = state
            .staging
            .keys()
            .filter(|id| !state.pending_stages.contains(id.as_str()))
            .cloned()
            .collect::<Vec<_>>();
        for id in stale {
            self.discard(state, &id)?;
        }
        Ok(())
    }
    pub(super) fn inspect_into(
        &self,
        state: &mut State,
        input: &Value,
        work: &std::path::Path,
    ) -> Result<Value> {
        let (source, pin, listed_in, expected) = self.resolve_source(state, input, work)?;
        let id = uuid::Uuid::new_v4().to_string();
        let stage = work.join("staging").join(&id);
        let result = (|| {
            let mut files = inspect::snapshot(&source, &stage, inspect::Limits::default())?;
            if pin.is_some() {
                let modes = sources::modes(&source)?;
                for file in &mut files {
                    file.mode = butler_platform::plugin_files::git_mode(
                        &file.mode,
                        modes.get(&file.path).map(String::as_str),
                    );
                }
            }
            let package = manifest::read(&stage)?;
            if input
                .get("name")
                .and_then(Value::as_str)
                .is_some_and(|n| n != package.name)
            {
                return Err(error("plugin_registry_name_mismatch"));
            }
            let digest = inspect::digest(&files);
            if expected.is_some_and(|d| d != digest) {
                return Err(error("plugin_registry_digest_mismatch"));
            }
            let inspection = Inspection {
                staging_id: id.clone(),
                source: pin
                    .as_ref()
                    .map(|p| p.git.clone())
                    .unwrap_or_else(|| source.to_string_lossy().into_owned()),
                pin,
                listed_in,
                digest,
                package,
                files,
            };
            let view = self.inspection_view(&inspection)?;
            state.staging.insert(id.clone(), Arc::new(inspection));
            Ok(view)
        })();
        if result.is_err() {
            let _ = std::fs::remove_dir_all(stage);
        }
        result
    }
    pub(super) fn inspection_view(&self, i: &Inspection) -> Result<Value> {
        let caps = capabilities::derive_capabilities(&i.package)?;
        let caps = overlay::resolve_preview(
            caps,
            &self.root.join("store").join(&i.digest),
            &self.root.join("data").join(&i.package.name),
        )?;
        Ok(
            json!({"staging_id":i.staging_id,"source":i.source,"pin":i.pin,"listed_in":i.listed_in,
            "source_kind":source_kind(i.pin.as_ref()),"version":i.package.version,"id":i.package.name,"author":i.package.author,"publisher_verified":false,
            "digest":i.digest,"short_digest":i.digest.get(..12),"capabilities":caps,
            "compatibility":i.package.compatibility,"notice":"runs_with_your_permissions"}),
        )
    }
    fn local_source(&self, path: &str) -> Result<PathBuf> {
        if std::fs::symlink_metadata(path).is_ok_and(|m| m.is_symlink()) {
            return Err(error("plugin_symlink_refused"));
        }
        let source = PathBuf::from(path)
            .canonicalize()
            .map_err(|_| error("plugin_path_unreadable"))?;
        if source.starts_with(&self.root) || self.root.starts_with(&source) {
            return Err(error("plugin_source_overlaps_storage"));
        }
        Ok(source)
    }
    fn resolve_source(
        &self,
        state: &State,
        input: &Value,
        work: &std::path::Path,
    ) -> Result<ResolvedSource> {
        let kinds = ["path", "git", "registry"]
            .iter()
            .filter(|k| input.get(**k).is_some())
            .count();
        if kinds != 1 {
            return Err(error("plugin_source_invalid"));
        }
        if let Some(path) = input.get("path").and_then(Value::as_str) {
            let source = self.local_source(path)?;
            return Ok((source, None, None, None));
        }
        let (request, listed, expected, registry_commit) = registry_entry(state, input)?;
        let remote = sources::url(
            request
                .get("git")
                .and_then(Value::as_str)
                .ok_or_else(|| error("plugin_git_url_invalid"))?,
        )?;
        let reference = request
            .get("ref")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let requested_commit = request
            .get("commit")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let (source, commit) = sources::checkout(
            work,
            &remote,
            reference.as_deref(),
            requested_commit.as_deref(),
        )?;
        Ok((
            source,
            Some(SourcePin {
                git: remote,
                commit,
                reference,
                requested_commit,
                registry: input
                    .get("registry")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                name: input.get("name").and_then(Value::as_str).map(str::to_owned),
                registry_commit,
            }),
            listed,
            expected,
        ))
    }
}

fn registry_entry(state: &State, input: &Value) -> Result<RegistryRequest> {
    let mut request = input.clone();
    let mut listed = None;
    let mut expected = None;
    let mut registry_commit = None;
    if let Some(id) = input.get("registry").and_then(Value::as_str) {
        let registry = state
            .registry
            .registries
            .get(id)
            .ok_or_else(|| error("plugin_registry_not_found"))?;
        let entry = registry
            .entries
            .get(
                input
                    .get("name")
                    .and_then(Value::as_str)
                    .ok_or_else(|| error("plugin_registry_entry_not_found"))?,
            )
            .ok_or_else(|| error("plugin_registry_entry_not_found"))?;
        request = json!({"git":entry.git,"ref":entry.reference,"commit":entry.commit});
        listed = Some(
            json!({"registry":id,"url":registry.url,"name":entry.name,"commit":registry.commit}),
        );
        expected = entry.digest.clone();
        registry_commit = Some(registry.commit.clone());
    }
    Ok((request, listed, expected, registry_commit))
}
