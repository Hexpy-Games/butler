use std::sync::Arc;

use crate::{
    btcc::BtccError,
    capabilities::Capabilities,
    skills::Skills,
    workspace::{WorkspaceFiles, WorkspaceMutations},
};

use super::{GuidedCatalog, RuntimePaths};

type SkillsOwner = (Arc<Skills>, Arc<Capabilities>, Arc<GuidedCatalog>);

pub(super) fn open(
    paths: &RuntimePaths,
    files: &WorkspaceFiles,
    mutations: &WorkspaceMutations,
) -> Result<SkillsOwner, BtccError> {
    let skills = Arc::new(Skills::for_installation(
        paths.resource_root.clone(),
        paths.data_root.clone(),
        paths.executable_path.clone(),
    ));
    let capabilities = Arc::new(Capabilities::with_skills(
        Arc::new(files.clone()),
        Arc::new(mutations.clone()),
        skills.clone(),
    ));
    let catalog = Arc::new(
        GuidedCatalog::load(&capabilities)
            .map_err(|e| BtccError::relayed("guided_catalog_unavailable", e.to_string()))?,
    );
    Ok((skills, capabilities, catalog))
}
