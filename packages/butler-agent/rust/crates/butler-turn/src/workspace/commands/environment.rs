use std::collections::HashMap;
use std::path::Path;

use super::CommandError;

pub(super) fn guided_environment(
    host: &HashMap<String, String>,
    butler_data: &Path,
) -> Result<HashMap<String, String>, CommandError> {
    let mut env = butler_platform::command_sandbox::tool_environment(host);
    let temporary = butler_data.join("tmp");
    let cache = butler_data.join("cache/tools");
    let artifacts = butler_data.join("artifacts/generated");
    std::fs::create_dir_all(&temporary).map_err(CommandError::io)?;
    std::fs::create_dir_all(&cache).map_err(CommandError::io)?;
    let temporary = temporary.to_string_lossy().into_owned();
    let cache = cache.to_string_lossy().into_owned();
    let artifacts = artifacts.to_string_lossy().into_owned();
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
