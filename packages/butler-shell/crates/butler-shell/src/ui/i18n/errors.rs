//! `settingsErrorCopy` (`app/settingsErrors.ts`) and `notifyError` (`app/notifications.ts`): a
//! failure toast shows the sentence of the API error code the client carries
//! (`Error::Http(_, Some(code))`), from `settingsErrorCopy`'s `messages` and then
//! `serverErrors`, else the caller's fallback. The server's message is never shown.
use butler_ds::ui::context::{Ds, Lang};
use butler_ds::ui::toast::Toast;
use butler_shell_client::Error;
use gpui::{App, SharedString};

/// `settingsErrorCopy(error, fallback)`: the sentence of a known API error code, else `fallback`.
pub(crate) fn copy(lang: Lang, error: &Error, fallback: impl Into<SharedString>) -> SharedString {
    let Error::Http(_, Some(code)) = error else {
        return fallback.into();
    };
    let Some([en, ko]) = sentence(code) else {
        return fallback.into();
    };
    match lang {
        Lang::En => en.into(),
        Lang::Ko => ko.into(),
    }
}

/// `notifyError(error, fallback)`: the caller adds its toast id (`.id(..)`) and shows it.
pub(crate) fn toast(cx: &App, error: &Error, fallback: impl Into<SharedString>) -> Toast {
    Toast::error(copy(Ds::get(cx).lang(), error, fallback))
}

/// The (en, ko) sentence of an API error code: `settingsErrorCopy`'s `messages`, then
/// `serverErrors`, each arm naming its catalog path.
fn sentence(code: &str) -> Option<[&'static str; 2]> {
    Some(match code {
        // settings.errors.saveFailed
        "invalid_settings_request" => ["Couldn't save.", "저장하지 못했습니다."],
        // serverErrors.settings_model_unavailable
        "settings_model_unavailable" => [
            "That model is no longer available.",
            "선택한 모델을 더 이상 사용할 수 없습니다.",
        ],
        // settings.mcpIdRequired
        "mcp_server_id_required" => ["Enter a server ID.", "서버 ID를 입력합니다."],
        // settings.mcpIdInvalid
        "mcp_server_id_invalid" => [
            "Use letters, numbers, dots, underscores or hyphens (1–80).",
            "영문·숫자·점·밑줄·하이픈 1~80자로 입력합니다.",
        ],
        // settings.mcpCommandRequired
        "mcp_command_required" => ["Enter a command.", "명령을 입력합니다."],
        // settings.mcpUrlRequired
        "mcp_url_required" => ["Enter a URL.", "URL을 입력합니다."],
        // settings.mcpErrors.save
        "mcp_server_save_failed"
        | "mcp_server_update_failed"
        | "mcp_config_invalid"
        | "mcp_secret_unreadable" => ["Couldn't save the server.", "서버를 저장하지 못했습니다."],
        // settings.mcpErrors.notFound
        "mcp_server_not_found" => [
            "This server was already removed.",
            "이미 삭제된 서버입니다.",
        ],
        // settings.mcpErrors.unavailable
        "mcp_registry_unavailable" => {
            ["Couldn't open MCP settings.", "MCP 설정을 열지 못했습니다."]
        }
        // settings.skillErrors.invalid
        "skill_archive_invalid" | "skill_archive_path_invalid" | "skill_path_invalid" => {
            ["That isn't a skill .zip.", "스킬 .zip 파일이 아닙니다."]
        }
        // settings.skillErrors.tooLarge
        "skill_file_too_large" => ["That file is too large.", "파일이 너무 큽니다."],
        // settings.wallpaper.moduleInvalid
        "wallpaper_module_archive_invalid"
        | "wallpaper_module_invalid"
        | "wallpaper_module_request_invalid" => [
            "That wallpaper file isn't valid.",
            "월페이퍼 파일이 올바르지 않습니다.",
        ],
        // settings.wallpaper.moduleTooLarge
        "wallpaper_module_archive_too_large" | "wallpaper_module_file_too_large" => {
            ["Modules up to 2 MB.", "2MB 이하 모듈만 가능"]
        }
        // settings.wallpaper.moduleExists
        "wallpaper_module_exists" => ["Module already installed.", "이미 설치된 모듈"],
        // settings.wallpaper.imageUnsupported
        "wallpaper_unsupported_type"
        | "wallpaper_image_invalid"
        | "wallpaper_dimensions_unsupported" => {
            ["JPG, PNG or WebP only.", "JPG, PNG, WebP 이미지만 가능"]
        }
        // settings.wallpaper.imageTooLarge
        "wallpaper_too_large" => ["That image is too large.", "이미지가 너무 큽니다."],
        // settings.localModelErrors.discover
        "local_model_discovery_failed" => [
            "No models found at this address.",
            "이 주소에서 모델을 찾지 못했습니다.",
        ],
        // settings.localModelErrors.register
        "local_model_registration_failed" | "local_model_update_failed" => {
            ["Couldn't add the model.", "모델을 추가하지 못했습니다."]
        }
        // firstRun.keyErrors.invalid
        "provider_auth_error" | "credential_key_invalid" => [
            "This key can't connect. Copy it again and paste it.",
            "이 키로 연결할 수 없습니다. 키를 다시 복사해 붙여 넣으세요.",
        ],
        // firstRun.keyErrors.noaccess
        "provider_permission_error" | "provider_quota_exhausted" => [
            "This key can't use models. Check billing or access.",
            "이 키로는 모델을 쓸 수 없습니다. 결제나 사용 권한을 확인하세요.",
        ],
        // firstRun.keyErrors.network
        "provider_network_error" | "provider_timeout" => [
            "Can't reach the service. Check your connection.",
            "서비스에 연결할 수 없습니다. 인터넷 연결을 확인하세요.",
        ],
        // serverErrors.provider_credential_save_failed
        "provider_credential_save_failed" => {
            ["Couldn't save the key.", "키를 저장하지 못했습니다."]
        }
        // serverErrors.image_model_credential_invalid, serverErrors.credential_not_found
        "image_model_credential_invalid" | "credential_not_found" => [
            "This key was already deleted. Refresh the list.",
            "이미 삭제된 키입니다. 목록을 새로 고치세요.",
        ],
        // serverErrors.image_model_requires_api_key
        "image_model_requires_api_key" => ["Only API keys work here.", "API 키만 쓸 수 있습니다."],
        // serverErrors.image_model_unknown
        "image_model_unknown" => [
            "This image model isn't available.",
            "이 이미지 모델은 쓸 수 없습니다.",
        ],
        // serverErrors.output_transfer_pending
        "output_transfer_pending" => [
            "Outputs are being moved. Please try again shortly.",
            "결과물을 옮기는 중입니다. 잠시 후 다시 시도해 주세요.",
        ],
        // serverErrors.model_not_in_chatgpt_plan
        "model_not_in_chatgpt_plan" => [
            "That model isn't in your ChatGPT plan.",
            "ChatGPT 플랜에 없는 모델입니다.",
        ],
        // serverErrors.credential_in_use_by_default
        "credential_in_use_by_default" => [
            "The default model uses this key. Change the default model first.",
            "기본 모델이 이 키를 씁니다. 기본 모델을 먼저 바꾸세요.",
        ],
        // serverErrors.credential_in_use
        "credential_in_use" => [
            "Models use this key. Delete them with the key.",
            "이 키를 쓰는 모델이 있습니다. 키와 함께 삭제하세요.",
        ],
        // serverErrors.space_changed
        "space_changed" => [
            "The list changed. Refresh it and try again.",
            "목록이 변경되었습니다. 최신 목록에서 다시 시도해 주세요.",
        ],
        // serverErrors.space_invalid_group
        "space_invalid_group" => [
            "Select two different conversations.",
            "서로 다른 두 대화를 선택해 주세요.",
        ],
        // serverErrors.space_invalid_scope
        "space_invalid_scope" => [
            "Group conversations within the same project.",
            "같은 프로젝트의 대화끼리 묶을 수 있습니다.",
        ],
        // serverErrors.space_invalid_pin
        "space_invalid_pin" => [
            "Pin a conversation or project.",
            "대화 또는 프로젝트를 즐겨찾기에 추가해 주세요.",
        ],
        // serverErrors.space_undo_expired
        "space_undo_expired" => [
            "Other changes prevent undoing this action.",
            "다른 변경이 있어 되돌릴 수 없습니다.",
        ],
        // serverErrors.space_invalid_title
        "space_invalid_title" => [
            "Enter a group name between 1 and 120 characters.",
            "그룹 이름은 1~120자로 입력해 주세요.",
        ],
        // serverErrors.branch_source_required
        "branch_source_required" => [
            "A source conversation is required.",
            "출처 대화가 필요합니다.",
        ],
        // serverErrors.branch_source_invalid
        "branch_source_invalid" => [
            "Select a response from this conversation.",
            "이 대화의 답변을 선택해 주세요.",
        ],
        // serverErrors.branch_source_unavailable
        "branch_source_unavailable" => [
            "No completed response is available to branch.",
            "분리할 완료된 답변이 없습니다.",
        ],
        // serverErrors.branch_cancelled
        "branch_cancelled" => [
            "Conversation creation was cancelled.",
            "새 대화 만들기가 취소되었습니다.",
        ],
        // serverErrors.branch_identity_conflict
        "branch_identity_conflict" => [
            "The creation request changed.",
            "같은 생성 요청의 내용이 변경되었습니다.",
        ],
        // serverErrors.branch_request_invalid
        "branch_request_invalid" => [
            "Check the new conversation title and source.",
            "새 대화의 제목과 출처를 확인해 주세요.",
        ],
        // serverErrors.branch_origin_unavailable
        "branch_origin_unavailable" => [
            "The source response is no longer available.",
            "원본 답변을 찾을 수 없습니다.",
        ],
        // serverErrors.session_relocating
        "session_relocating" => [
            "The conversation is moving. Try again shortly.",
            "대화를 이동하고 있습니다. 잠시 후 다시 시도해 주세요.",
        ],
        // serverErrors.relocation_identity_conflict
        "relocation_identity_conflict" => [
            "The move request changed.",
            "이동 요청의 내용이 달라졌습니다.",
        ],
        // serverErrors.relocation_aborted
        "relocation_aborted" => [
            "The move did not finish. Check its status.",
            "이동이 완료되지 않았습니다. 이동 상태를 확인해 주세요.",
        ],
        // serverErrors.session_context_changed
        "session_context_changed" => [
            "The conversation environment changed; the move could not finish.",
            "대화의 실행 환경이 변경되어 이동하지 못했습니다.",
        ],
        // serverErrors.session_not_movable
        "session_not_movable" => [
            "This conversation cannot be moved.",
            "이 대화는 이동할 수 없습니다.",
        ],
        // serverErrors.space_invalid_target
        "space_invalid_target" => [
            "Select a different destination.",
            "다른 이동 위치를 선택해 주세요.",
        ],
        // serverErrors.project_unavailable
        "project_unavailable" => [
            "Select an available project.",
            "사용 가능한 프로젝트를 선택해 주세요.",
        ],
        // serverErrors.same_session_context
        "same_session_context" => [
            "Use list organization to move within the same project.",
            "같은 프로젝트 안에서는 목록 이동을 사용해 주세요.",
        ],
        // serverErrors.model_not_configured
        "model_not_configured" => [
            "Configure a model first.",
            "먼저 사용할 모델을 설정해 주세요.",
        ],
        // serverErrors.session_context_conflict
        "session_context_conflict" => [
            "The move environment needs attention. Existing work is preserved.",
            "대화 이동의 실행 환경을 확인해야 합니다. 기존 작업은 보존되어 있습니다.",
        ],
        // serverErrors.relocation_preparation_missing
        "relocation_preparation_missing" => [
            "Move preparation information is unavailable.",
            "이동 준비 정보를 확인할 수 없습니다.",
        ],
        // serverErrors.session_busy
        "session_busy" => [
            "Wait for active work and queued messages to finish.",
            "진행 중인 작업과 대기 메시지가 끝난 뒤 다시 시도해 주세요.",
        ],
        // serverErrors.space_node_not_found
        "space_node_not_found" => [
            "Item not found. Refresh the list.",
            "항목을 찾을 수 없습니다. 목록을 새로 확인해 주세요.",
        ],
        // serverErrors.space_invalid_parent
        "space_invalid_parent" => [
            "Items cannot be placed inside a conversation.",
            "대화 안에 항목을 넣을 수 없습니다.",
        ],
        // serverErrors.space_scope_conflict
        "space_scope_conflict" => [
            "Use project relocation to change the parent project.",
            "프로젝트 소속을 바꾸려면 프로젝트 이동을 사용해 주세요.",
        ],
        // serverErrors.space_cycle
        "space_cycle" => [
            "An item cannot be moved into its own descendants.",
            "항목을 자신의 하위로 옮길 수 없습니다.",
        ],
        // serverErrors.invalid_message_content
        "invalid_message_content" => [
            "Check the conversation reference format.",
            "대화 참조의 형식이 올바르지 않습니다.",
        ],
        // serverErrors.image_payload_invalid
        "image_payload_invalid" => [
            "Could not process the image attachment.",
            "이미지 첨부를 처리할 수 없습니다.",
        ],
        _ => return None,
    })
}
