use std::{collections::HashMap, path::PathBuf, sync::Arc};

use butler_core::configuration::ConfigurationWrites;
use butler_models::mcp_client::McpClient;
use butler_models::mcp_client::RegistryPathGuard;

pub(super) fn for_runtime(
    paths: &super::RuntimePaths,
    host_environment: &Arc<HashMap<String, String>>,
    registry_writes: Arc<ConfigurationWrites>,
) -> Arc<McpClient> {
    new(
        paths.data_root.clone(),
        paths.installation_root.clone(),
        host_environment,
        registry_writes,
    )
}

pub(super) fn new(
    data_root: PathBuf,
    installation_root: PathBuf,
    host_environment: &Arc<HashMap<String, String>>,
    registry_writes: Arc<ConfigurationWrites>,
) -> Arc<McpClient> {
    let path_guard: Arc<RegistryPathGuard> = Arc::new(move |data_root, target| {
        let data_real =
            super::super::installation::realpath_or_nearest(data_root).map_err(|source| {
                crate::host::HostError::new("MCP registry DATA path is unavailable.")
                    .with_source(source)
            })?;
        let target_real =
            super::super::installation::realpath_or_nearest(target).map_err(|source| {
                crate::host::HostError::new("MCP registry path is unavailable.").with_source(source)
            })?;
        if !target_real.starts_with(&data_real) {
            return Err("MCP registry path escapes DATA.".into());
        }
        if data_real.starts_with(&installation_root)
            || installation_root.starts_with(&data_real)
            || target_real.starts_with(&installation_root)
        {
            return Err("MCP registry path overlaps the installation.".into());
        }
        Ok(())
    });
    Arc::new(McpClient::with_registry_writer(
        data_root,
        (**host_environment).clone(),
        registry_writes,
        path_guard,
    ))
}
