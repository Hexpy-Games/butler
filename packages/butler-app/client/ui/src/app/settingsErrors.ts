import { apiErrorCode } from "./api";
import { appCopy } from "./copy";

/** Bounded product copy; server messages and unknown codes never reach the UI. */
export function settingsErrorCopy(error: unknown, fallback: string): string {
  const copy = appCopy;
  const messages: Record<string, string> = {
    invalid_settings_request: copy.settings.errors.saveFailed,
    settings_model_unavailable: copy.serverErrors.settings_model_unavailable,
    mcp_server_id_required: copy.settings.mcpIdRequired,
    mcp_server_id_invalid: copy.settings.mcpIdInvalid,
    mcp_command_required: copy.settings.mcpCommandRequired,
    mcp_url_required: copy.settings.mcpUrlRequired,
    mcp_server_save_failed: copy.settings.mcpErrors.save,
    mcp_server_update_failed: copy.settings.mcpErrors.save,
    mcp_config_invalid: copy.settings.mcpErrors.save,
    mcp_secret_unreadable: copy.settings.mcpErrors.save,
    mcp_server_not_found: copy.settings.mcpErrors.notFound,
    mcp_registry_unavailable: copy.settings.mcpErrors.unavailable,
    skill_archive_invalid: copy.settings.skillErrors.invalid,
    skill_archive_path_invalid: copy.settings.skillErrors.invalid,
    skill_path_invalid: copy.settings.skillErrors.invalid,
    skill_file_too_large: copy.settings.skillErrors.tooLarge,
    wallpaper_module_archive_invalid: copy.settings.wallpaper.moduleInvalid,
    wallpaper_module_invalid: copy.settings.wallpaper.moduleInvalid,
    wallpaper_module_request_invalid: copy.settings.wallpaper.moduleInvalid,
    wallpaper_module_archive_too_large: copy.settings.wallpaper.moduleTooLarge,
    wallpaper_module_file_too_large: copy.settings.wallpaper.moduleTooLarge,
    wallpaper_module_exists: copy.settings.wallpaper.moduleExists,
    wallpaper_unsupported_type: copy.settings.wallpaper.imageUnsupported,
    wallpaper_image_invalid: copy.settings.wallpaper.imageUnsupported,
    wallpaper_dimensions_unsupported: copy.settings.wallpaper.imageUnsupported,
    wallpaper_too_large: copy.settings.wallpaper.imageTooLarge,
    local_model_discovery_failed: copy.settings.localModelErrors.discover,
    local_model_registration_failed: copy.settings.localModelErrors.register,
    local_model_update_failed: copy.settings.localModelErrors.register,
    provider_auth_error: copy.firstRun.keyErrors.invalid,
    credential_key_invalid: copy.firstRun.keyErrors.invalid,
    provider_permission_error: copy.firstRun.keyErrors.noaccess,
    provider_quota_exhausted: copy.firstRun.keyErrors.noaccess,
    provider_network_error: copy.firstRun.keyErrors.network,
    provider_timeout: copy.firstRun.keyErrors.network,
  };
  const code = apiErrorCode(error) ?? "";
  return messages[code] ?? copy.serverErrors[code] ?? fallback;
}
