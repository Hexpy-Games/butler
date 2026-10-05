import type { ProposalLocale } from "./state";

/**
 * Proposed product i18n keys (packages/butler-i18n), mirrored here so the proposal renders them.
 * `key` is the path under appCopy; `codes` are the backend error codes the key replaces (the
 * renderer maps code -> key, never shows the code or the server's message). `{x}` are params.
 */
export interface CopyEntry {
  key: string;
  ko: string;
  en: string;
  codes?: readonly string[];
  surface: "toast" | "field" | "notice" | "row" | "dialog" | "label";
  /** Already on main; listed for completeness (kept or reworded). */
  existing?: boolean;
}

export const UPDATE_COPY: readonly CopyEntry[] = [
  { key: "settings.updateProgress.checking", ko: "확인 중", en: "Checking", surface: "row" },
  { key: "settings.updateProgress.downloading", ko: "다운로드 중", en: "Downloading", surface: "row" },
  { key: "settings.updateProgress.downloadMeta", ko: "{percent}% · {done} / {total}", en: "{percent}% · {done} of {total}", surface: "row" },
  { key: "settings.updateProgress.downloadedBytes", ko: "{done} 받음", en: "{done} downloaded", surface: "row" },
  { key: "settings.updateProgress.verifying", ko: "파일 확인 중", en: "Verifying", surface: "row" },
  { key: "settings.updateProgress.ready", ko: "다시 시작하면 적용됩니다.", en: "Restart to finish.", surface: "row" },
  { key: "settings.updateProgress.restart", ko: "다시 시작", en: "Restart", surface: "label" },
  { key: "settings.updateProgress.applying", ko: "적용 중", en: "Applying", surface: "row" },
  { key: "settings.updateProgress.restarting", ko: "다시 시작하는 중", en: "Restarting", surface: "row" },
  { key: "settings.updateProgress.cancelled", ko: "다운로드를 취소했습니다.", en: "Download cancelled.", codes: ["update_cancelled"], surface: "toast" },
  { key: "shell.update.downloading", ko: "업데이트 받는 중", en: "Downloading update", surface: "row" },
  { key: "shell.update.working", ko: "업데이트 준비 중", en: "Preparing update", surface: "row" },
  { key: "shell.update.ready", ko: "업데이트 준비됨", en: "Update ready", surface: "row" },
  { key: "shell.update.failed", ko: "업데이트 실패", en: "Update failed", surface: "row" },
  { key: "shell.update.ring", ko: "업데이트 {percent}% · 열기", en: "Update {percent}% · Open", surface: "label" },
  { key: "settings.updateErrors.download", ko: "업데이트를 받지 못했습니다. 연결을 확인해 주세요.", en: "Couldn't download the update. Check your connection.", codes: ["update_http_unavailable", "update_artifact_unavailable", "update_manifest_unavailable"], surface: "notice" },
  { key: "settings.updateErrors.damaged", ko: "받은 파일을 확인하지 못했습니다. 다시 받아 주세요.", en: "The download didn't verify. Try again.", codes: ["update_artifact_sha256_mismatch", "update_manifest_sha256_mismatch", "update_signature_unsupported"], surface: "notice" },
  { key: "settings.updateErrors.incompatible", ko: "이 기기용 업데이트가 아직 없습니다.", en: "No update for this device yet.", codes: ["update_manifest_incompatible", "update_manifest_app_platform_missing", "update_manifest_agent_platform_missing"], surface: "notice" },
  { key: "settings.updateErrors.storage", ko: "업데이트 파일을 저장하지 못했습니다.", en: "Couldn't save the update file.", codes: ["update_stage_unavailable", "update_stage_path_invalid"], surface: "notice" },
  { key: "settings.updateErrors.apply", ko: "적용하지 못해 지금 버전을 유지합니다.", en: "Couldn't apply it. Your current version stays.", codes: ["update_activation_failed"], surface: "notice" },
  { key: "settings.updateErrors.generic", ko: "업데이트하지 못했습니다.", en: "Couldn't update.", codes: ["update_manifest_invalid", "update_manifest_*", "update_artifact_*", "update_status_invalid", "(other)"], surface: "notice" },
];

export const MOTION_COPY: readonly CopyEntry[] = [
  { key: "settings.pageSections.accessibility", ko: "접근성", en: "Accessibility", surface: "label" },
  { key: "settings.fields.reduceMotion", ko: "동작 줄이기", en: "Reduce motion", surface: "label" },
  { key: "settings.descriptions.reduceMotion", ko: "끄면 시스템 설정을 따릅니다.", en: "When off, follows your system setting.", surface: "label" },
  { key: "settings.descriptions.reduceMotionSystem", ko: "시스템 설정에서 켜져 있습니다", en: "On in your system settings", surface: "label" },
  { key: "settings.descriptions.wallpaperStill", ko: "동작 줄이기가 켜져 있어 멈춰 있습니다", en: "Paused by Reduce motion", surface: "label" },
];

export const ERROR_COPY: readonly CopyEntry[] = [
  { key: "settings.errors.saveFailed", ko: "저장하지 못했습니다.", en: "Couldn't save.", codes: ["invalid_settings_request", "(any PATCH /settings failure)"], surface: "toast" },
  { key: "serverErrors.settings_model_unavailable", ko: "선택한 모델을 더 이상 사용할 수 없습니다.", en: "That model is no longer available.", codes: ["settings_model_unavailable"], surface: "toast", existing: true },
  { key: "settings.mcpIdRequired", ko: "서버 ID를 입력합니다.", en: "Enter a server ID.", codes: ["mcp_server_id_required"], surface: "field", existing: true },
  { key: "settings.mcpIdInvalid", ko: "영문·숫자·점·밑줄·하이픈 1~80자로 입력합니다.", en: "Use letters, numbers, dots, underscores or hyphens (1–80).", codes: ["mcp_server_id_invalid"], surface: "field", existing: true },
  { key: "settings.mcpCommandRequired", ko: "명령을 입력합니다.", en: "Enter a command.", codes: ["mcp_command_required"], surface: "field", existing: true },
  { key: "settings.mcpUrlRequired", ko: "URL을 입력합니다.", en: "Enter a URL.", codes: ["mcp_url_required"], surface: "field", existing: true },
  { key: "settings.mcpErrors.save", ko: "서버를 저장하지 못했습니다.", en: "Couldn't save the server.", codes: ["mcp_server_save_failed", "mcp_server_update_failed", "mcp_config_invalid", "mcp_secret_unreadable"], surface: "toast" },
  { key: "settings.mcpErrors.notFound", ko: "이미 삭제된 서버입니다.", en: "This server was already removed.", codes: ["mcp_server_not_found"], surface: "toast" },
  { key: "settings.mcpErrors.unavailable", ko: "MCP 설정을 열지 못했습니다.", en: "Couldn't open MCP settings.", codes: ["mcp_registry_unavailable"], surface: "toast" },
  { key: "settings.mcpErrors.remove", ko: "서버를 삭제하지 못했습니다.", en: "Couldn't remove the server.", surface: "toast" },
  { key: "settings.mcpErrors.toggle", ko: "변경하지 못했습니다.", en: "Couldn't change it.", surface: "toast" },
  { key: "settings.mcpErrors.probe", ko: "연결을 확인하지 못했습니다.", en: "Couldn't reach the server.", surface: "toast" },
  { key: "settings.skillErrors.invalid", ko: "스킬 .zip 파일이 아닙니다.", en: "That isn't a skill .zip.", codes: ["skill_archive_invalid", "skill_archive_path_invalid", "skill_path_invalid"], surface: "field" },
  { key: "settings.skillErrors.tooLarge", ko: "파일이 너무 큽니다.", en: "That file is too large.", codes: ["skill_file_too_large"], surface: "field" },
  { key: "settings.skillErrors.import", ko: "가져오지 못했습니다.", en: "Couldn't import it.", codes: ["(other)"], surface: "field" },
  { key: "settings.security.invalidHost", ko: "호스트 이름이나 IP를 입력하세요", en: "Enter a host name or IP", surface: "field", existing: true },
  { key: "settings.wallpaper.moduleInvalid", ko: "월페이퍼 파일이 올바르지 않습니다.", en: "That wallpaper file isn't valid.", codes: ["wallpaper_module_archive_invalid", "wallpaper_module_invalid", "wallpaper_module_request_invalid"], surface: "field" },
  { key: "settings.wallpaper.moduleTooLarge", ko: "2MB 이하 모듈만 가능", en: "Modules up to 2 MB.", codes: ["wallpaper_module_archive_too_large", "wallpaper_module_file_too_large"], surface: "field", existing: true },
  { key: "settings.wallpaper.moduleExists", ko: "이미 설치된 모듈", en: "Module already installed.", codes: ["wallpaper_module_exists"], surface: "field", existing: true },
  { key: "settings.wallpaper.imageUnsupported", ko: "JPG, PNG, WebP 이미지만 가능", en: "JPG, PNG or WebP only.", codes: ["wallpaper_unsupported_type", "wallpaper_image_invalid", "wallpaper_dimensions_unsupported"], surface: "field" },
  { key: "settings.wallpaper.imageTooLarge", ko: "이미지가 너무 큽니다.", en: "That image is too large.", codes: ["wallpaper_too_large"], surface: "field" },
  { key: "settings.wallpaper.moduleImportFailed", ko: "모듈 가져오기 실패", en: "Module import failed.", codes: ["(other)"], surface: "field", existing: true },
  { key: "settings.archiveErrors.restore", ko: "복원하지 못했습니다.", en: "Couldn't restore it.", surface: "toast" },
  { key: "settings.archiveErrors.loadMore", ko: "더 불러오지 못했습니다.", en: "Couldn't load more.", surface: "toast" },
  { key: "settings.localModelErrors.discover", ko: "이 주소에서 모델을 찾지 못했습니다.", en: "No models found at this address.", codes: ["local_model_discovery_failed"], surface: "field" },
  { key: "settings.localModelErrors.register", ko: "모델을 추가하지 못했습니다.", en: "Couldn't add the model.", codes: ["local_model_registration_failed", "local_model_update_failed"], surface: "toast" },
  { key: "firstRun.keyErrors.invalid", ko: "이 키로 연결할 수 없습니다. 키를 다시 복사해 붙여 넣으세요.", en: "This key can't connect. Copy it again and paste it.", codes: ["provider_auth_error", "credential_key_invalid"], surface: "field", existing: true },
  { key: "firstRun.keyErrors.noaccess", ko: "이 키로는 모델을 쓸 수 없습니다. 결제나 사용 권한을 확인하세요.", en: "This key can't use models. Check billing or access.", codes: ["provider_permission_error", "provider_quota_exhausted"], surface: "field", existing: true },
  { key: "firstRun.keyErrors.network", ko: "서비스에 연결할 수 없습니다. 인터넷 연결을 확인하세요.", en: "Can't reach the service. Check your connection.", codes: ["provider_network_error", "provider_timeout"], surface: "field", existing: true },
  { key: "settings.grants.revokeFailed", ko: "허용을 해제하지 못했습니다.", en: "Couldn't revoke it.", codes: ["(DELETE /authority-permissions failure)"], surface: "toast" },
  { key: "settings.grants.loadFailed", ko: "허용 목록을 불러오지 못했습니다.", en: "Couldn't load approvals.", surface: "notice" },
];

export const GRANT_COPY: readonly CopyEntry[] = [
  { key: "settings.sectionDescriptions.security", ko: "접속, 권한, 키와 진단 정보를 관리합니다.", en: "Manage access, permissions, keys and diagnostics.", surface: "label" },
  { key: "settings.sectionAliases.security (+)", ko: "권한, 허용한 작업, API 키, 저장된 키, 진단, 개인정보", en: "permissions, approvals, API keys, saved keys, diagnostics, privacy", surface: "label" },
  { key: "settings.pageSections.grants", ko: "허용한 작업", en: "Approved actions", surface: "label" },
  { key: "settings.pageSectionDescriptions.grants", ko: "묻지 않고 실행하도록 허용한 작업입니다.", en: "Actions Butler runs without asking.", surface: "label" },
  { key: "settings.grants.kind.command", ko: "명령 실행", en: "Run command", surface: "label" },
  { key: "settings.grants.kind.fileWrite", ko: "파일 쓰기", en: "Write files", surface: "label" },
  { key: "settings.grants.kind.network", ko: "네트워크", en: "Network", surface: "label" },
  { key: "settings.grants.kind.tool", ko: "외부 도구", en: "External tool", surface: "label" },
  { key: "settings.grants.kind.other", ko: "기타 작업", en: "Other action", surface: "label" },
  { key: "settings.grants.scope.conversation", ko: "대화", en: "Chat", surface: "label" },
  { key: "settings.grants.scope.project", ko: "프로젝트", en: "Project", surface: "label" },
  { key: "settings.grants.scope.always", ko: "항상", en: "Always", surface: "label" },
  { key: "settings.grants.conversations", ko: "대화 {count}개", en: "{count} chats", surface: "row" },
  { key: "settings.grants.cwd", ko: "위치 {path}", en: "In {path}", surface: "row" },
  { key: "settings.grants.revoke", ko: "허용 해제", en: "Revoke", surface: "label" },
  { key: "settings.grants.revokeAlwaysTitle", ko: "항상 허용을 해제할까요?", en: "Revoke this always-on approval?", surface: "dialog" },
  { key: "settings.grants.revokeAlwaysMessage", ko: "다음부터는 실행 전에 묻습니다.", en: "Butler will ask before running it again.", surface: "dialog" },
  { key: "settings.grants.revoked", ko: "허용을 해제했습니다.", en: "Revoked.", surface: "toast" },
  { key: "settings.grants.search", ko: "허용한 작업 검색", en: "Search approvals", surface: "label" },
  { key: "settings.grants.filter", ko: "종류", en: "Kind", surface: "label" },
  { key: "settings.grants.filterAll", ko: "전체", en: "All", surface: "label" },
  { key: "settings.grants.empty", ko: "허용한 작업이 없습니다.", en: "No approved actions.", surface: "row" },
  { key: "settings.grants.noMatch", ko: "검색 결과가 없습니다.", en: "No matches.", surface: "row" },
  { key: "settings.grants.targetUnknown", ko: "대상 정보 없음", en: "Target not recorded", surface: "row" },
];

const ALL = [...UPDATE_COPY, ...MOTION_COPY, ...ERROR_COPY, ...GRANT_COPY];
const INDEX = new Map(ALL.map((entry) => [entry.key, entry]));

/** Proposed copy by key, with `{name}` params filled. */
export function t(locale: ProposalLocale, key: string, params: Record<string, string | number> = {}): string {
  const entry = INDEX.get(key);
  if (!entry) throw new Error(`Missing proposal copy: ${key}`);
  const text = locale === "ko-KR" ? entry.ko : entry.en;
  return text.replace(/\{(\w+)\}/gu, (_, name: string) => String(params[name] ?? ""));
}
