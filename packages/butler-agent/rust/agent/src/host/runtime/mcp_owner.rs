use std::{collections::HashMap, path::PathBuf, sync::Arc};

use crate::{
    configuration::ConfigurationWrites,
    mcp_client::{NativeMcpClient, RegistryPathGuard},
};

pub(super) fn for_runtime(
    paths: &super::NativeRuntimePaths,
    host_environment: &Arc<HashMap<String, String>>,
    registry_writes: Arc<ConfigurationWrites>,
) -> Arc<NativeMcpClient> {
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
) -> Arc<NativeMcpClient> {
    let path_guard: Arc<RegistryPathGuard> = Arc::new(move |data_root, target| {
        let data_real = super::super::installation::realpath_or_nearest(data_root)
            .map_err(|_| "MCP registry DATA path is unavailable.".to_owned())?;
        let target_real = super::super::installation::realpath_or_nearest(target)
            .map_err(|_| "MCP registry path is unavailable.".to_owned())?;
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
    Arc::new(NativeMcpClient::with_registry_writer(
        data_root,
        (**host_environment).clone(),
        registry_writes,
        path_guard,
    ))
}
