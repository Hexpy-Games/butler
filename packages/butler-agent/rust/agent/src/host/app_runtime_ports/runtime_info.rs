use crate::gateway::{AppRuntimeInfoProvider, GatewayApplicationError};

pub(crate) struct NativeAppRuntimeInfo {
    app_version: Option<String>,
}

impl NativeAppRuntimeInfo {
    pub(crate) fn open(installation: &super::super::installation::ResolvedInstallation) -> Self {
        Self {
            app_version: installation.app_version(),
        }
    }
}

impl AppRuntimeInfoProvider for NativeAppRuntimeInfo {
    fn app_version(&self) -> Result<String, GatewayApplicationError> {
        self.app_version
            .clone()
            .ok_or_else(|| GatewayApplicationError::Public {
                status: 503,
                code: "app_info_unavailable".into(),
                message: "Installed App version metadata is unavailable.".into(),
            })
    }
}
