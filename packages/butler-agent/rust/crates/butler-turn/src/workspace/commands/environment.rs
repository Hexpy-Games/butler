use std::collections::HashMap;
use std::path::{Path, PathBuf};

use super::CommandError;

/// The scratch folders a guided command may write besides its workspace.
pub(super) struct Scratch {
    pub(super) temporary: PathBuf,
    pub(super) cache: PathBuf,
    pub(super) artifacts: PathBuf,
}

impl Scratch {
    /// The same roots feed both the write grant and post-run link judgment.
    pub(super) fn writable_roots(&self) -> [&Path; 3] {
        [&self.temporary, &self.cache, &self.artifacts]
    }

    /// A project-write command gets its own temp and cache folders, so it can
    /// neither touch another Butler component's temp files nor plant files an
    /// unsandboxed command later picks up from a shared cache.
    pub(super) fn new(butler_data: &Path, project_write: bool) -> Self {
        let (temporary, cache) = if project_write {
            (
                butler_platform::data_paths::PROJECT_WRITE_TMP,
                butler_platform::data_paths::PROJECT_WRITE_CACHE,
            )
        } else {
            (
                butler_platform::data_paths::TEMPORARY,
                butler_platform::data_paths::TOOL_CACHE,
            )
        };
        Self {
            temporary: butler_data.join(temporary),
            cache: butler_data.join(cache),
            artifacts: butler_data.join(butler_platform::data_paths::ARTIFACTS),
        }
    }
}

pub(super) fn guided_environment(
    host: &HashMap<String, String>,
    butler_data: &Path,
) -> Result<HashMap<String, String>, CommandError> {
    scratch_environment(host, butler_data, &Scratch::new(butler_data, false))
}

pub(super) fn scratch_environment(
    host: &HashMap<String, String>,
    butler_data: &Path,
    scratch: &Scratch,
) -> Result<HashMap<String, String>, CommandError> {
    let mut env = butler_platform::command_sandbox::tool_environment(host);
    std::fs::create_dir_all(&scratch.temporary).map_err(CommandError::io)?;
    std::fs::create_dir_all(&scratch.cache).map_err(CommandError::io)?;
    let temporary = scratch.temporary.to_string_lossy().into_owned();
    let cache = scratch.cache.to_string_lossy().into_owned();
    let artifacts = scratch.artifacts.to_string_lossy().into_owned();
    for key in ["TMPDIR", "TEMP", "TMP"] {
        env.insert(key.to_owned(), temporary.clone());
    }
    env.insert("XDG_CACHE_HOME".into(), cache);
    env.insert(
        "BUTLER_DATA".into(),
        butler_data.to_string_lossy().into_owned(),
    );
    env.insert("BUTLER_ARTIFACTS_DIR".into(), artifacts.clone());
    env.insert("BUTLER_ARTIFACT_DIR".into(), artifacts);
    Ok(env)
}
