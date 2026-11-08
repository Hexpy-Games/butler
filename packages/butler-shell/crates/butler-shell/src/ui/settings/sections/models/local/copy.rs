//! The copy of a Custom model's settings. Each field names its `packages/butler-i18n` key
//! (`settings.localModels.*` unless it says otherwise).
use butler_ds::ui::context::{Ds, Lang};
use gpui::App;

pub(super) struct Words {
    /// apiKey
    pub(super) api_key: &'static str,
    /// apiKeyDescription
    pub(super) api_key_description: &'static str,
    /// apiKeyPlaceholder
    pub(super) api_key_placeholder: &'static str,
    /// apiKeyRemoved
    pub(super) api_key_removed: &'static str,
    /// removeApiKey
    pub(super) remove_api_key: &'static str,
    /// description
    pub(super) description: &'static str,
    /// apiInfoTitle
    pub(super) api_info_title: &'static str,
    /// modelInfoTitle
    pub(super) model_info_title: &'static str,
    /// apiType
    pub(super) api_type: &'static str,
    /// apiDescription
    pub(super) api_description: &'static str,
    /// platformHint
    pub(super) platform_hint: &'static str,
    /// serverUrl
    pub(super) server_url: &'static str,
    /// discoverModels
    pub(super) discover_models: &'static str,
    /// discovering
    pub(super) discovering: &'static str,
    /// registerModel
    pub(super) register_model: &'static str,
    /// saving
    pub(super) saving: &'static str,
    /// saveModel
    pub(super) save_model: &'static str,
    /// showAdvanced
    pub(super) show_advanced: &'static str,
    /// hideAdvanced
    pub(super) hide_advanced: &'static str,
    /// unsavedChanges
    pub(super) unsaved_changes: &'static str,
    /// discoveredModel
    pub(super) discovered_model: &'static str,
    /// discoveredModelDescription
    pub(super) discovered_model_description: &'static str,
    /// modelId
    pub(super) model_id: &'static str,
    /// displayName
    pub(super) display_name: &'static str,
    /// maxContext
    pub(super) max_context: &'static str,
    /// responseTimeout
    pub(super) response_timeout: &'static str,
    /// imageInput
    pub(super) image_input: &'static str,
    /// customOpenAiCompatible
    pub(super) custom_openai_compatible: &'static str,
    /// localModelErrors.discover
    pub(super) discover_failed: &'static str,
    /// localModelErrors.register
    pub(super) register_failed: &'static str,
    /// interfaceFeedback.contextUnknown
    pub(super) context_unknown: &'static str,
    /// discoveredStatus
    pub(super) discovered_status: fn(usize) -> String,
    /// registeredStatus
    pub(super) registered_status: fn(&str) -> String,
    /// savedStatus
    pub(super) saved_status: fn(&str) -> String,
    /// responseTimeoutDescription (the default in seconds)
    pub(super) timeout_description: fn(Option<f64>) -> String,
    /// responseTimeoutError (min and max in seconds)
    pub(super) timeout_error: fn(Option<(f64, f64)>) -> String,
}

const KO: Words = Words {
    api_key: "API 키 (선택)",
    api_key_description: "인증이 필요한 서버의 키를 입력하세요. 편집 시 입력하지 않으면 기존 키를 유지합니다. API 주소를 변경하면 키를 다시 입력하세요.",
    api_key_placeholder: "키 입력 또는 기존 키 유지",
    api_key_removed: "저장하면 키가 제거됩니다",
    remove_api_key: "API 키 제거",
    description: "로컬 서버나 외부 제공자의 OpenAI 호환 Chat Completions API를 등록합니다. 모델 검색 없이 ID를 직접 입력할 수도 있습니다.",
    api_info_title: "모델 API 정보",
    model_info_title: "모델 정보",
    api_type: "API 유형",
    api_description: "API 표준을 우선 사용하고, 플랫폼은 호환성 힌트로만 사용합니다.",
    platform_hint: "플랫폼 힌트",
    server_url: "API 기본 URL",
    discover_models: "모델 찾기",
    discovering: "찾는 중",
    register_model: "모델 등록",
    saving: "저장 중",
    save_model: "모델 저장",
    show_advanced: "설정 더보기",
    hide_advanced: "설정 접기",
    unsaved_changes: "저장하지 않은 변경사항이 있습니다. 페이지를 벗어나면 변경사항이 사라집니다.",
    discovered_model: "찾은 모델",
    discovered_model_description: "사용할 수 있으면 서버 실행 창을 기본 컨텍스트로 사용합니다.",
    model_id: "모델 ID",
    display_name: "표시 이름",
    max_context: "최대 컨텍스트",
    response_timeout: "응답 대기 시간",
    image_input: "이미지 입력",
    custom_openai_compatible: "사용자 지정 OpenAI 호환",
    discover_failed: "이 주소에서 모델을 찾지 못했습니다.",
    register_failed: "모델을 추가하지 못했습니다.",
    context_unknown: "컨텍스트 미확인",
    discovered_status: |count| format!("사용자 지정 모델 {count}개를 찾았습니다."),
    registered_status: |name| format!("{name} 모델을 등록했습니다."),
    saved_status: |name| format!("{name} 모델을 저장했습니다."),
    timeout_description: |default| match default {
        None => "초 단위. 비우면 기본값을 씁니다.".to_owned(),
        Some(seconds) => format!("초 단위. 비우면 기본값({seconds}초)을 씁니다."),
    },
    timeout_error: |range| match range {
        None => "0보다 큰 초를 입력하세요.".to_owned(),
        Some((min, max)) => format!("{min}~{max}초로 입력하세요."),
    },
};

const EN: Words = Words {
    api_key: "API key (optional)",
    api_key_description: "Enter a key if the server requires authentication. Leave untouched to keep the saved key. Re-enter it when changing the API URL.",
    api_key_placeholder: "Enter a key or keep the saved key",
    api_key_removed: "Key will be removed on save",
    remove_api_key: "Remove API key",
    description: "Connect local servers or other providers using an OpenAI-compatible Chat Completions API. Enter a model ID directly if discovery is unavailable.",
    api_info_title: "Model API information",
    model_info_title: "Model information",
    api_type: "API type",
    api_description: "Butler prefers API standards. Platform is used only as a compatibility hint.",
    platform_hint: "Platform hint",
    server_url: "API base URL",
    discover_models: "Discover models",
    discovering: "Discovering",
    register_model: "Register model",
    saving: "Saving",
    save_model: "Save model",
    show_advanced: "Show advanced settings",
    hide_advanced: "Hide advanced settings",
    unsaved_changes: "You have unsaved changes. Leaving this page will discard them.",
    discovered_model: "Discovered model",
    discovered_model_description: "When available, Butler uses the server runtime window as the default context.",
    model_id: "Model ID",
    display_name: "Display name",
    max_context: "Max context",
    response_timeout: "Response timeout",
    image_input: "Image input",
    custom_openai_compatible: "Custom OpenAI-compatible",
    discover_failed: "No models found at this address.",
    register_failed: "Couldn't add the model.",
    context_unknown: "context unknown",
    discovered_status: |count| format!("Found {count} Custom models."),
    registered_status: |name| format!("{name} was registered."),
    saved_status: |name| format!("{name} was saved."),
    timeout_description: |default| match default {
        None => "In seconds. Leave empty to use the default.".to_owned(),
        Some(seconds) => format!("In seconds. Leave empty to use the default ({seconds}s)."),
    },
    timeout_error: |range| match range {
        None => "Enter seconds above 0.".to_owned(),
        Some((min, max)) => format!("Enter {min} to {max} seconds."),
    },
};

pub(super) fn words(lang: Lang) -> &'static Words {
    match lang {
        Lang::Ko => &KO,
        Lang::En => &EN,
    }
}

/// The copy of the app language.
pub(super) fn get(cx: &App) -> &'static Words {
    words(Ds::get(cx).lang())
}
