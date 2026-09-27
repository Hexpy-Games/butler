use butler_gateway::gateway::AppRuntimeInfoProvider;
use butler_gateway::gateway::GatewayApplicationError;

pub(crate) struct AppRuntimeInfo {
    app_version: Option<String>,
}

impl AppRuntimeInfo {
    pub(crate) fn open(installation: &crate::host::installation::ResolvedInstallation) -> Self {
        Self {
            app_version: installation.app_version(),
        }
    }
}

impl AppRuntimeInfoProvider for AppRuntimeInfo {
    fn app_version(&self) -> Result<String, GatewayApplicationError> {
        self.app_version
            .clone()
            .ok_or_else(|| GatewayApplicationError::Public {
                status: 503,
                code: "app_info_unavailable".into(),
                message: "Installed App version metadata is unavailable.".into(),
                source: None,
            })
    }
}
