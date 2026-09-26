//! Profile-owned personalization state, import and rendering operations.

use std::{ffi::OsString, fs, io::Read, path::PathBuf};

use serde_json::{Value, json};

use crate::profile::{
    ClearProfilingResult, PersonalizationProfile, PersonalizationProfileUpdate, ProfileService,
    ProfileThirdPartyImportOptions, ProfilingConsentSnapshot, ProfilingExtractorModelSnapshot,
    ProfilingMode, third_party_migration_prompt,
};

use super::{CliError, Options};

const PROFILE_STORAGE_LABEL: &str = "personalization/profile.json";
const PROFILE_BLACK_BOX_STORAGE_LABEL: &str = "cognition/profile/profile.sqlite";

pub(super) async fn show(profile: &ProfileService) -> Result<(Value, String), CliError> {
    let profile_value = profile
        .read_personalization_profile()
        .await
        .map_err(profile_error)?;
    let consent = profile
        .read_profiling_consent()
        .await
        .map_err(profile_error)?;
    let model = profile
        .read_extractor_model()
        .await
        .map_err(profile_error)?;
    let data = show_data(&profile_value, &consent, &model);
    let human = format!(
        "Personalization profile\nButler nickname: {}\nPrincipal name: {}\nPreferred address: {}\nStorage: {PROFILE_STORAGE_LABEL}\nProfiling: {}\nProfile extractor model: {} ({})\nProfile black box: {PROFILE_BLACK_BOX_STORAGE_LABEL}",
        display_value(&profile_value.butler_nickname),
        display_value(&profile_value.principal_name),
        display_value(&profile_value.preferred_address),
        consent.mode.as_str(),
        model.configured_model.as_deref().unwrap_or("default"),
        model.effective_model,
    );
    Ok((data, human))
}

pub(super) async fn set(
    args: &[OsString],
    profile: &ProfileService,
) -> Result<(Value, String), CliError> {
    let update = PersonalizationProfileUpdate {
        butler_nickname: option(args, &["--butler-nickname", "--butler-name"])?,
        principal_name: option(args, &["--principal-name", "--user-name"])?,
        preferred_address: option(args, &["--preferred-address", "--address"])?,
    };
    let mode = option(args, &["--profiling-mode"])?;
    if let Some(value) = &mode
        && !matches!(value.as_str(), "off" | "basic" | "deep")
    {
        return Err(CliError::invalid(
            "--profiling-mode must be off, basic, or deep",
        ));
    }
    let extractor = option(
        args,
        &["--profiling-extractor-model", "--profile-extractor-model"],
    )?;
    let clear = args.iter().any(|value| value == "--clear-profile");
    if update.butler_nickname.is_none()
        && update.principal_name.is_none()
        && update.preferred_address.is_none()
        && mode.is_none()
        && extractor.is_none()
        && !clear
    {
        return Err(CliError::invalid(
            "personalization set requires at least one profile, profiling, extractor-model, or --clear-profile option",
        ));
    }
    validate_flags(
        args,
        &[
            "--butler-nickname",
            "--butler-name",
            "--principal-name",
            "--user-name",
            "--preferred-address",
            "--address",
            "--profiling-mode",
            "--profiling-extractor-model",
            "--profile-extractor-model",
            "--clear-profile",
        ],
    )?;
    let profile_value = if update.butler_nickname.is_some()
        || update.principal_name.is_some()
        || update.preferred_address.is_some()
    {
        profile
            .update_personalization_profile(update.clone())
            .await
            .map_err(profile_error)?
    } else {
        profile
            .read_personalization_profile()
            .await
            .map_err(profile_error)?
    };
    let consent = match mode.as_deref() {
        Some(value) => profile
            .set_profiling_mode(ProfilingMode::parse(value))
            .await
            .map_err(profile_error)?,
        None => profile
            .read_profiling_consent()
            .await
            .map_err(profile_error)?,
    };
    let model = match extractor {
        Some(value) => profile
            .set_extractor_model(Some(value))
            .await
            .map_err(profile_error)?,
        None => profile
            .read_extractor_model()
            .await
            .map_err(profile_error)?,
    };
    let cleared: Option<ClearProfilingResult> = if clear {
        Some(
            profile
                .clear_profiling_data()
                .await
                .map_err(profile_error)?,
        )
    } else {
        None
    };
    let updated_fields = updated_fields(&update);
    let mut data = show_data(&profile_value, &consent, &model);
    data["updated_fields"] = json!(updated_fields);
    data["cleared_profile"] = serde_json::to_value(cleared).unwrap_or(Value::Null);
    let human = format!(
        "Personalization profile updated.\nStorage: {PROFILE_STORAGE_LABEL}\nProfiling: {}\nProfile extractor model: {} ({})\nProfile black box: {PROFILE_BLACK_BOX_STORAGE_LABEL}",
        consent.mode.as_str(),
        model.configured_model.as_deref().unwrap_or("default"),
        model.effective_model,
    );
    Ok((data, human))
}

pub(super) async fn import(
    args: &[OsString],
    profile: &ProfileService,
) -> Result<(Value, String), CliError> {
    let file = os_option(args, "--file")?;
    let source = option(args, &["--source"])?.unwrap_or_else(|| "external-ai".into());
    let model = option(args, &["--model"])?;
    validate_flags(args, &["--file", "--stdin", "--source", "--model"])?;
    let stdin = args.iter().any(|value| value == "--stdin")
        || file.as_deref().is_some_and(|path| path.as_os_str() == "-");
    let Some(file) = file else {
        if !stdin {
            return Err(CliError::invalid(
                "personalization migration import requires --file PATH or --stdin",
            ));
        }
        let mut text = String::new();
        std::io::stdin().read_to_string(&mut text).map_err(|_| {
            CliError::failed(
                "personalization_input_unavailable",
                "Import input could not be read.",
            )
        })?;
        return import_text(profile, source, text, model).await;
    };
    if stdin {
        let mut text = String::new();
        std::io::stdin().read_to_string(&mut text).map_err(|_| {
            CliError::failed(
                "personalization_input_unavailable",
                "Import input could not be read.",
            )
        })?;
        return import_text(profile, source, text, model).await;
    }
    let text = fs::read_to_string(file).map_err(|_| {
        CliError::failed(
            "personalization_input_unavailable",
            "Import input could not be read.",
        )
    })?;
    import_text(profile, source, text, model).await
}

async fn import_text(
    profile: &ProfileService,
    source: String,
    text: String,
    model: Option<String>,
) -> Result<(Value, String), CliError> {
    let result = profile
        .import_profile_candidates_from_third_party_dump_with_model(
            ProfileThirdPartyImportOptions {
                text,
                source: Some(source),
                model,
                now_epoch_millis: None,
                cancellation: Default::default(),
            },
        )
        .await
        .map_err(profile_error)?;
    let human = format!(
        "{}\nSource: {}\nModel called: {}\nImported candidates: {}\nPromoted entries: {}\nStable profile entries: {}\nRaw import text stored: no",
        if result.profiling_enabled {
            "Profile migration imported."
        } else {
            "Profiling is off; profile migration skipped."
        },
        result.source,
        result.model_called,
        result.imported_candidate_count,
        result.promoted_count,
        result.stable_entry_count,
    );
    Ok((serde_json::to_value(result).unwrap_or(Value::Null), human))
}

pub(super) fn migration_prompt(options: &Options) -> Result<(Value, String), CliError> {
    let args = &options.positionals[2..];
    let locale = option(args, &["--locale"])?;
    validate_flags(args, &["--locale"])?;
    let locale = if locale.as_deref() == Some("ko") {
        "ko"
    } else {
        "en"
    };
    let prompt = third_party_migration_prompt(locale);
    Ok((
        json!({ "locale": locale, "prompt": prompt, "raw_profile_included": false }),
        prompt,
    ))
}

fn show_data(
    profile: &PersonalizationProfile,
    consent: &ProfilingConsentSnapshot,
    model: &ProfilingExtractorModelSnapshot,
) -> Value {
    json!({
        "profile": profile,
        "storage_label": PROFILE_STORAGE_LABEL,
        "profiling": {
            "mode": consent.mode,
            "enabled": consent.mode != ProfilingMode::Off,
            "consent_version": consent.consent_version,
            "consented_at": consent.consented_at,
            "storage_label": PROFILE_BLACK_BOX_STORAGE_LABEL,
            "raw_profile_browser_visible": false,
            "extractor_model": model.configured_model.as_deref().unwrap_or("default"),
            "effective_extractor_model": model.effective_model,
            "extractor_uses_butler_model": model.uses_butler_model,
        }
    })
}

fn option(args: &[OsString], names: &[&str]) -> Result<Option<String>, CliError> {
    for name in names {
        if let Some(index) = args.iter().position(|value| value == name) {
            let Some(value) = args
                .get(index + 1)
                .filter(|value| !value.to_string_lossy().starts_with("--") && !value.is_empty())
            else {
                return Ok(None);
            };
            return value
                .clone()
                .into_string()
                .map(Some)
                .map_err(|_| CliError::invalid(format!("{name} requires UTF-8 text")));
        }
    }
    Ok(None)
}

fn os_option(args: &[OsString], name: &str) -> Result<Option<PathBuf>, CliError> {
    let Some(index) = args.iter().position(|value| value == name) else {
        return Ok(None);
    };
    let Some(value) = args
        .get(index + 1)
        .filter(|value| !value.to_string_lossy().starts_with("--") && !value.is_empty())
    else {
        return Ok(None);
    };
    Ok(Some(PathBuf::from(value)))
}

fn validate_flags(args: &[OsString], allowed: &[&str]) -> Result<(), CliError> {
    let mut index = 0;
    while index < args.len() {
        let value = args[index].to_string_lossy();
        if !value.starts_with('-') {
            index += 1;
            continue;
        }
        if (value == "--stdin" || value == "--clear-profile") && allowed.contains(&value.as_ref()) {
            index += 1;
            continue;
        }
        if !allowed.contains(&value.as_ref()) {
            return Err(CliError::invalid(format!("unsupported option: {value}")));
        }
        index += 2;
    }
    Ok(())
}

fn updated_fields(update: &PersonalizationProfileUpdate) -> Vec<&'static str> {
    let mut fields = Vec::new();
    if update.butler_nickname.is_some() {
        fields.push("butler_nickname");
    }
    if update.principal_name.is_some() {
        fields.push("principal_name");
    }
    if update.preferred_address.is_some() {
        fields.push("preferred_address");
    }
    fields.sort_unstable();
    fields
}

fn display_value(value: &str) -> &str {
    if value.is_empty() { "(unset)" } else { value }
}

fn profile_error(error: crate::profile::ProfileError) -> CliError {
    CliError::failed(error.code, error.message)
}
