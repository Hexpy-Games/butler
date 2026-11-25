//! The Butler account (butler-cloud): sign-in by email code, the plan, devices.
use crate::gateway::GatewayApplicationError;

/// One account operation; the host forwards it to butler-cloud.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum ButlerAccountRequest {
    Start {
        email: String,
    },
    Verify {
        email: String,
        code: String,
    },
    DevPlan {
        plan: String,
    },
    #[serde(skip)]
    Status,
    #[serde(skip)]
    SignOut,
    #[serde(skip)]
    Devices,
    #[serde(skip)]
    RevokeDevice {
        id: String,
    },
}

/// `404 butler_account_disabled`: the feature is off on this computer.
pub fn butler_account_disabled() -> GatewayApplicationError {
    GatewayApplicationError::Public {
        status: 404,
        code: "butler_account_disabled".into(),
        message: "The Butler account is off on this computer.".into(),
        source: None,
    }
}
