//! macOS: `SMAppService.mainAppService`, the registration of the running `.app`.
use smappservice_rs::{AppService, ServiceStatus, ServiceType};

use super::LoginItemError;

/// Whether the main app service is enabled.
pub(super) fn enabled() -> bool {
    AppService::new(ServiceType::MainApp).status() == ServiceStatus::Enabled
}

/// Registers or unregisters the main app service; already in the wanted state is success.
pub(super) fn set(open_at_login: bool) -> Result<(), LoginItemError> {
    if enabled() == open_at_login {
        return Ok(());
    }
    let service = AppService::new(ServiceType::MainApp);
    let (call, result) = if open_at_login {
        ("SMAppService register", service.register())
    } else {
        ("SMAppService unregister", service.unregister())
    };
    result.map_err(|error| LoginItemError::Failed(format!("{call} failed (code {})", error.code())))
}
