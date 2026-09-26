//! Process model and dependent public-web owners opened as one composition.

use std::sync::Arc;

use crate::btcc::BtccError;
use crate::configuration::ConfigurationWrites;
use crate::locale::LocaleCollation;
use crate::mcp_client::NativeMcpClient;
use crate::models::ModelConfigurationEnvironment;
use crate::operations::WebSearchMetrics;
use crate::web_access::WebAccess;

use super::super::NativeProcessModels;
use super::NativeRuntimePaths;

pub(super) struct ProcessWebServices {
    pub models: NativeProcessModels,
    pub web_access: Arc<WebAccess>,
}

pub(super) fn open(
    paths: &NativeRuntimePaths,
    model_environment: ModelConfigurationEnvironment,
    writes: &Arc<ConfigurationWrites>,
    collation: &Arc<LocaleCollation>,
    mcp_client: Arc<NativeMcpClient>,
) -> Result<ProcessWebServices, BtccError> {
    let models = NativeProcessModels::new_with_mcp(
        paths.data_root.clone(),
        model_environment,
        writes.clone(),
        collation.clone(),
        mcp_client,
    )?;
    let web_access = Arc::new(
        WebAccess::new(
            paths.data_root.clone(),
            models.configuration.clone(),
            models.provider.clone(),
            Arc::new(WebSearchMetrics::new(paths.data_root.clone())),
        )
        .map_err(|error| BtccError::relayed(error.code, error.message))?,
    );
    Ok(ProcessWebServices { models, web_access })
}
