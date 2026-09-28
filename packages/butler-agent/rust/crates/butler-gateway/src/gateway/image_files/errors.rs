//! Public image attachment refusals and their wording in the App language.

use super::GatewayApplicationError;
use crate::gateway::ui_language::UiLanguage;

/// A public image attachment refusal. The wire strings are the App contract.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ImageErrorCode {
    ModelUnsupported,
    CapabilityUnknown,
    CarrierUnavailable,
    RouteIncompatible,
    CarrierUnverified,
    PayloadInvalid,
    ManifestInvalid,
    SourceTampered,
}

impl ImageErrorCode {
    const ALL: [Self; 8] = [
        Self::ModelUnsupported,
        Self::CapabilityUnknown,
        Self::CarrierUnavailable,
        Self::RouteIncompatible,
        Self::CarrierUnverified,
        Self::PayloadInvalid,
        Self::ManifestInvalid,
        Self::SourceTampered,
    ];

    pub(crate) const fn wire(self) -> &'static str {
        match self {
            Self::ModelUnsupported => "image_model_unsupported",
            Self::CapabilityUnknown => "image_capability_unknown",
            Self::CarrierUnavailable => "image_carrier_unavailable",
            Self::RouteIncompatible => "image_route_incompatible",
            Self::CarrierUnverified => "image_carrier_unverified",
            Self::PayloadInvalid => "image_payload_invalid",
            Self::ManifestInvalid => "image_manifest_invalid",
            Self::SourceTampered => "image_source_tampered",
        }
    }

    pub(crate) fn from_wire(code: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|candidate| candidate.wire() == code)
    }

    /// The code of an image admission check (runtime or model catalog).
    /// Those checks only report the codes above; anything else is treated as
    /// an invalid payload rather than leaking an unknown code to the App.
    pub(crate) fn from_admission(code: &str) -> Self {
        Self::from_wire(code).unwrap_or(Self::PayloadInvalid)
    }

    const fn status(self) -> u16 {
        match self {
            Self::PayloadInvalid => 413,
            Self::ManifestInvalid => 422,
            _ => 409,
        }
    }

    fn message(self, language: UiLanguage) -> &'static str {
        match language {
            UiLanguage::English => self.english(),
            UiLanguage::Korean => self.korean(),
        }
    }

    const fn english(self) -> &'static str {
        match self {
            Self::ModelUnsupported => {
                "The selected model can't read images. Choose a model that supports images or remove the image."
            }
            Self::CapabilityUnknown => {
                "Butler can't confirm that the selected model reads images. Check the model settings or remove the image."
            }
            Self::CarrierUnavailable => {
                "No adapter can send images to the selected model. Check the model connection settings."
            }
            Self::RouteIncompatible => {
                "The selected model's connection doesn't accept image input. Check the connection settings."
            }
            Self::CarrierUnverified => "Butler can't verify how the image would be sent.",
            Self::PayloadInvalid | Self::ManifestInvalid => {
                "Butler can't check this image attachment."
            }
            Self::SourceTampered => "Image attachment could not be verified.",
        }
    }

    const fn korean(self) -> &'static str {
        match self {
            Self::ModelUnsupported => {
                "현재 모델은 이미지를 읽을 수 없습니다. 이미지 지원 모델을 선택하거나 이미지를 제거하세요."
            }
            Self::CapabilityUnknown => {
                "현재 모델의 이미지 지원 여부를 확인할 수 없습니다. 모델 설정을 확인하거나 이미지를 제거하세요."
            }
            Self::CarrierUnavailable => {
                "현재 모델로 이미지를 전송할 수 있는 어댑터가 없습니다. 모델 연결 설정을 확인하세요."
            }
            Self::RouteIncompatible => {
                "현재 모델 연결 경로는 이미지 입력과 호환되지 않습니다. 연결 설정을 확인하세요."
            }
            Self::CarrierUnverified => "이미지 전송 경로를 확인할 수 없습니다.",
            Self::PayloadInvalid | Self::ManifestInvalid => "이미지 첨부를 확인할 수 없습니다.",
            Self::SourceTampered => "이미지 첨부를 검증할 수 없습니다.",
        }
    }
}

/// The refusal `code` with its usual status, worded in English (the App's
/// language is applied by [`localize_image_error`] on the reply).
pub(crate) fn image_error(code: ImageErrorCode) -> GatewayApplicationError {
    image_error_with_status(code, code.status())
}

/// The refusal `code` with a specific `status`.
pub(crate) fn image_error_with_status(
    code: ImageErrorCode,
    status: u16,
) -> GatewayApplicationError {
    GatewayApplicationError::Public {
        status,
        code: code.wire().into(),
        message: code.message(UiLanguage::English).into(),
        source: None,
    }
}

/// Gives an image attachment refusal the App's `language`; other errors are
/// returned unchanged.
pub(crate) fn localize_image_error(
    error: GatewayApplicationError,
    language: UiLanguage,
) -> GatewayApplicationError {
    match error {
        GatewayApplicationError::Public {
            status,
            code,
            message,
            source,
        } => {
            let message = ImageErrorCode::from_wire(&code)
                .map_or(message, |image| image.message(language).into());
            GatewayApplicationError::Public {
                status,
                code,
                message,
                source,
            }
        }
        other @ GatewayApplicationError::Internal { .. } => other,
    }
}
