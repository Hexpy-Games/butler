//! The copy of model management, the ChatGPT sign-in card and the image models. Each field names
//! its `packages/butler-i18n` key.
use butler_ds::ui::context::Lang;

pub(super) struct Words {
    /// conversation.imageTools.custom
    pub(super) custom: &'static str,
    /// conversation.imageTools.name
    pub(super) name: &'static str,
    /// conversation.imageTools.endpointUrl
    pub(super) endpoint_url: &'static str,
    /// conversation.imageTools.modelId
    pub(super) model_id: &'static str,
    /// conversation.imageTools.optionalApiKey
    pub(super) optional_api_key: &'static str,
    /// settings.modelManagement.imageTitle
    pub(super) image_title: &'static str,
    /// settings.modelManagement.manageButton
    pub(super) manage_button: &'static str,
    /// common.cancel
    pub(super) cancel: &'static str,
    /// common.save
    pub(super) save: &'static str,

    /// settings.modelManagement.addTitle
    pub(super) add_title: &'static str,
    /// settings.modelManagement.editTitle
    pub(super) edit_title: &'static str,
    /// settings.modelManagement.addButton
    pub(super) add_button: &'static str,
    /// settings.modelManagement.registeredTitle
    pub(super) registered_title: &'static str,
    /// settings.modelManagement.emptyRegistered
    pub(super) empty_registered: &'static str,
    /// settings.modelManagement.provider
    pub(super) provider: &'static str,
    /// settings.modelManagement.model
    pub(super) model: &'static str,
    /// settings.modelManagement.authMethod
    pub(super) auth_method: &'static str,
    /// settings.modelManagement.apiBaseUrl
    pub(super) api_base_url: &'static str,
    /// settings.modelManagement.apiKey
    pub(super) api_key: &'static str,
    /// settings.modelManagement.credential
    pub(super) credential: &'static str,
    /// settings.modelManagement.credentialLabel
    pub(super) credential_label: &'static str,
    /// settings.modelManagement.newCredential
    pub(super) new_credential: &'static str,
    /// settings.modelManagement.chatgptOauth
    pub(super) chatgpt_oauth: &'static str,
    /// settings.modelManagement.apiKeyAuth
    pub(super) api_key_auth: &'static str,
    /// settings.modelManagement.saveAdd
    pub(super) save_add: &'static str,
    /// settings.modelManagement.saveEdit
    pub(super) save_edit: &'static str,
    /// settings.modelManagement.saving
    pub(super) saving: &'static str,
    /// settings.modelManagement.edit
    pub(super) edit: &'static str,
    /// settings.modelManagement.delete (and common.delete)
    pub(super) delete: &'static str,
    /// settings.modelManagement.deleteConfirm
    pub(super) delete_confirm: fn(&str) -> String,
    /// settings.modelManagement.registeredStatus
    pub(super) registered_status: fn(&str) -> String,
    /// settings.modelManagement.deletedStatus
    pub(super) deleted_status: fn(&str) -> String,
    /// settings.modelManagement.authTag
    pub(super) auth_tag: fn(&str, &str) -> String,
    /// settings.modelManagement.errors.save
    pub(super) error_save: &'static str,
    /// settings.modelManagement.errors.delete
    pub(super) error_delete: &'static str,
    /// settings.pageSections.modelProvider
    pub(super) section_provider: &'static str,
    /// settings.options.local
    pub(super) local: &'static str,
    /// chatgptPlan.continue
    pub(super) plan_continue: &'static str,
    /// chatgptPlan.otherAccount
    pub(super) other_account: &'static str,
    /// chatgptPlan.planOff
    pub(super) plan_off: &'static str,
    /// chatgptPlan.turnOn
    pub(super) turn_on: &'static str,
    /// chatgptPlan.signInAgainHint
    pub(super) sign_in_again_hint: &'static str,
    /// chatgptPlan.signOut
    pub(super) sign_out: &'static str,
    /// chatgptPlan.signedOut
    pub(super) signed_out: &'static str,
    /// chatgptPlan.revokeUnconfirmed
    pub(super) revoke_unconfirmed: &'static str,
    /// chatgptPlan.manageUsage
    pub(super) manage_usage: &'static str,
    /// chatgptSignIn.idle
    pub(super) sign_in_idle: &'static str,
    /// chatgptSignIn.pending
    pub(super) sign_in_pending: &'static str,
    /// chatgptSignIn.open
    pub(super) sign_in_open: &'static str,
    /// chatgptSignIn.copy
    pub(super) sign_in_copy: &'static str,
    /// chatgptSignIn.copied
    pub(super) sign_in_copied: &'static str,
    /// chatgptSignIn.timedOut
    pub(super) sign_in_timed_out: &'static str,
    /// chatgptSignIn.failed
    pub(super) sign_in_failed: &'static str,
    /// chatgptSignIn.restart
    pub(super) sign_in_restart: &'static str,
    /// chatgptSignIn.complete
    pub(super) sign_in_complete: &'static str,
    /// chatgptSignIn.addHint
    pub(super) sign_in_add_hint: &'static str,
    /// firstRun.signInAccountMismatch
    pub(super) account_mismatch: &'static str,
    /// firstRun.signInDiscoveryOffline
    pub(super) discovery_offline: &'static str,
    /// conversation.imageTools.off
    pub(super) image_off: &'static str,
    /// conversation.imageTools.defaultQuality
    pub(super) default_quality: &'static str,
    /// conversation.imageTools.quality: low, medium, high, xhigh, max
    pub(super) qualities: [(&'static str, &'static str); 5],
}

static KO: Words = Words {
    custom: "커스텀",
    name: "이름",
    endpoint_url: "엔드포인트 URL",
    model_id: "모델 ID",
    optional_api_key: "API 키 (선택)",
    image_title: "이미지 모델 관리",
    manage_button: "모델 관리",
    cancel: "취소",
    save: "저장",

    add_title: "모델 추가",
    edit_title: "모델 편집",
    add_button: "모델 추가",
    registered_title: "등록된 모델",
    empty_registered: "아직 등록된 모델이 없습니다.",
    provider: "제공자",
    model: "모델",
    auth_method: "인증 방식",
    api_base_url: "API 기본 URL",
    api_key: "API 키",
    credential: "저장된 인증",
    credential_label: "인증 이름",
    new_credential: "새로 작성",
    chatgpt_oauth: "ChatGPT 플랜",
    api_key_auth: "API 키",
    save_add: "추가",
    save_edit: "저장",
    saving: "저장 중",
    edit: "편집",
    delete: "삭제",
    delete_confirm: |name| format!("{name} 모델을 선택 가능 목록에서 삭제할까요?"),
    registered_status: |name| format!("{name} 모델을 등록했습니다."),
    deleted_status: |name| format!("{name} 모델을 삭제했습니다."),
    auth_tag: |auth, credential| format!("{auth} · {credential}"),
    error_save: "모델 등록 실패",
    error_delete: "모델 삭제 실패",
    section_provider: "제공자",
    local: "사용자 지정",
    plan_continue: "ChatGPT로 계속하기",
    other_account: "다른 계정 사용",
    plan_off: "플랜 사용 꺼짐",
    turn_on: "켜기",
    sign_in_again_hint: "ChatGPT에 다시 로그인하세요",
    sign_out: "로그아웃",
    signed_out: "ChatGPT에서 로그아웃했습니다",
    revoke_unconfirmed: "여기서는 로그아웃했지만 ChatGPT 확인은 받지 못했습니다.",
    manage_usage: "사용량 관리",
    sign_in_idle: "ChatGPT에 로그인하세요",
    sign_in_pending: "브라우저에서 로그인을 마치세요.",
    sign_in_open: "브라우저에서 열기",
    sign_in_copy: "링크 복사",
    sign_in_copied: "링크를 복사했습니다",
    sign_in_timed_out: "로그인 시간이 지났습니다",
    sign_in_failed: "로그인하지 못했습니다",
    sign_in_restart: "로그인 다시 시작",
    sign_in_complete: "로그인됨",
    sign_in_add_hint: "먼저 ChatGPT에 로그인하세요",
    account_mismatch: "다른 ChatGPT 계정입니다",
    discovery_offline: "ChatGPT에 연결할 수 없습니다. 연결을 확인하세요.",
    image_off: "사용 안 함",
    default_quality: "기본 품질",
    qualities: [
        ("low", "낮음"),
        ("medium", "보통"),
        ("high", "높음"),
        ("xhigh", "매우 높음"),
        ("max", "최고"),
    ],
};

static EN: Words = Words {
    custom: "Custom",
    name: "Name",
    endpoint_url: "Endpoint URL",
    model_id: "Model ID",
    optional_api_key: "API key (optional)",
    image_title: "Image model management",
    manage_button: "Manage models",
    cancel: "Cancel",
    save: "Save",

    add_title: "Add model",
    edit_title: "Edit model",
    add_button: "Add model",
    registered_title: "Registered models",
    empty_registered: "No registered models yet.",
    provider: "Provider",
    model: "Model",
    auth_method: "Auth method",
    api_base_url: "API base URL",
    api_key: "API key",
    credential: "Saved credential",
    credential_label: "Credential name",
    new_credential: "New credential",
    chatgpt_oauth: "ChatGPT plan",
    api_key_auth: "API key",
    save_add: "Add",
    save_edit: "Save",
    saving: "Saving",
    edit: "Edit",
    delete: "Delete",
    delete_confirm: |name| format!("Delete {name} from selectable models?"),
    registered_status: |name| format!("{name} was registered."),
    deleted_status: |name| format!("{name} was deleted."),
    auth_tag: |auth, credential| format!("{auth} · {credential}"),
    error_save: "Failed to register model",
    error_delete: "Failed to delete model",
    section_provider: "Provider",
    local: "Custom",
    plan_continue: "Continue with ChatGPT",
    other_account: "Use another account",
    plan_off: "Plan use is off",
    turn_on: "Turn on",
    sign_in_again_hint: "Sign in to ChatGPT again",
    sign_out: "Sign out",
    signed_out: "Signed out of ChatGPT",
    revoke_unconfirmed: "Signed out here. ChatGPT didn't confirm.",
    manage_usage: "Manage usage",
    sign_in_idle: "Sign in to ChatGPT",
    sign_in_pending: "Finish signing in in your browser.",
    sign_in_open: "Open in browser",
    sign_in_copy: "Copy link",
    sign_in_copied: "Link copied",
    sign_in_timed_out: "Sign-in timed out",
    sign_in_failed: "Couldn't sign in",
    sign_in_restart: "Start sign-in again",
    sign_in_complete: "Signed in",
    sign_in_add_hint: "Sign in to ChatGPT first",
    account_mismatch: "That's a different ChatGPT account",
    discovery_offline: "Can't reach ChatGPT. Check your connection.",
    image_off: "Off",
    default_quality: "Default quality",
    qualities: [
        ("low", "Low"),
        ("medium", "Medium"),
        ("high", "High"),
        ("xhigh", "Very high"),
        ("max", "Max"),
    ],
};

pub(super) fn words(lang: Lang) -> &'static Words {
    match lang {
        Lang::Ko => &KO,
        Lang::En => &EN,
    }
}
