use super::{Plugins, Result, error, inspect, types::*};
use std::path::Path;

pub(super) fn files(root: &Path, records: &[FileRecord], hashes: bool) -> Result<()> {
    for record in records {
        let file =
            butler_platform::secure_fs::open_package_file(root, inspect::relative(&record.path)?)
                .map_err(|_| error("changed_on_disk"))?;
        let meta = file.metadata().map_err(|_| error("changed_on_disk"))?;
        if !meta.is_file()
            || meta.is_symlink()
            || meta.len() != record.size
            || meta.modified().ok() != Some(record.modified)
            || (hashes && inspect::hash_file(file)? != record.hash)
        {
            return Err(error("changed_on_disk"));
        }
    }
    Ok(())
}
impl Plugins {
    pub(super) fn verify(&self, id: &str, entrypoints: &[String], hook: bool) -> Result<Installed> {
        let _mutation = self.mutation.lock();
        self.verify_locked(id, entrypoints, hook)
    }
    pub(super) fn verify_locked(
        &self,
        id: &str,
        entrypoints: &[String],
        hook: bool,
    ) -> Result<Installed> {
        let mut state = self.state.lock().clone();
        if self.safe_mode {
            return Err(error("plugin_safe_mode"));
        }
        let plugin = state
            .registry
            .plugins
            .get(id)
            .filter(|p| p.enabled && p.quarantine.is_none())
            .cloned()
            .ok_or_else(|| error("plugin_unavailable"))?;
        let root = self
            .root
            .join("store")
            .join(&plugin.approval.content_digest);
        let result = (|| {
            if !state.verified.contains(id) {
                files(&root, &plugin.files, false)?;
            }
            if hook || !state.verified.contains(id) {
                for entry in entrypoints {
                    let path = Path::new(entry);
                    let Ok(relative) = path.strip_prefix(&root) else {
                        continue;
                    };
                    let relative = relative
                        .iter()
                        .map(|s| s.to_string_lossy())
                        .collect::<Vec<_>>()
                        .join("/");
                    let expected = if hook {
                        plugin.approval.hook_hashes.get(&relative)
                    } else {
                        plugin
                            .files
                            .iter()
                            .find(|f| f.path == relative)
                            .map(|f| &f.hash)
                    }
                    .ok_or_else(|| error("changed_on_disk"))?;
                    let file =
                        butler_platform::secure_fs::open_package_file(&root, Path::new(&relative))
                            .map_err(|_| error("changed_on_disk"))?;
                    if inspect::hash_file(file)? != *expected {
                        return Err(error("changed_on_disk"));
                    }
                }
            }
            Ok(())
        })();
        if result.is_err() {
            let mut next = state.registry.clone();
            if let Some(p) = next.plugins.get_mut(id) {
                p.quarantine = Some("changed_on_disk".into());
            }
            next.revision += 1;
            self.save(&next)?;
            state.registry = next;
            *self.state.lock() = state;
            return Err(error("changed_on_disk"));
        }
        state.verified.insert(id.into());
        *self.state.lock() = state;
        Ok(plugin)
    }
}
