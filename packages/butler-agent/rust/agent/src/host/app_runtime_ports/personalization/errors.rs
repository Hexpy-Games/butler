use crate::gateway::GatewayApplicationError;

#[expect(
    clippy::needless_pass_by_value,
    reason = "map_err/iterator adapter taking owned values"
)]
pub(super) fn profile_error(error: crate::profile::ProfileError) -> GatewayApplicationError {
    GatewayApplicationError::Public {
        status: 500,
        code: error.code.into(),
        message: "Personalization operation failed.".into(),
    }
}

pub(super) fn model_error(_: String) -> GatewayApplicationError {
    GatewayApplicationError::Public {
        status: 500,
        code: "personalization_settings_unavailable".into(),
        message: "Personalization settings are unavailable.".into(),
    }
}

pub(super) fn invalid_request() -> GatewayApplicationError {
    GatewayApplicationError::Public {
        status: 400,
        code: "invalid_personalization_request".into(),
        message: "Personalization update contains unsupported fields.".into(),
    }
}

pub(super) fn unsafe_personalization_path() -> GatewayApplicationError {
    GatewayApplicationError::Public {
        status: 409,
        code: "unsafe_personalization_path".into(),
        message: "Personalization storage is outside the selected DATA directory.".into(),
    }
}
