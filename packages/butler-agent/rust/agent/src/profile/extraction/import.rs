use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::Path;

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use super::super::contracts::*;
use super::super::{candidates, extractor_config, storage};
use super::{Dependencies, parser, prompt, runtime};
use crate::json::Utf16Prefix;
use crate::models::{ProviderPromptLifecycle, ProviderPromptRequest};

pub(super) async fn run(
    dependencies: Dependencies,
    options: ProfileThirdPartyImportOptions,
    cancellation: CancellationToken,
) -> ProfileResult<ProfileThirdPartyImportResult> {
    let source = normalize_source(options.source.as_deref());
    let root = dependencies.root.clone();
    let (mut model_config, consent) = runtime::blocking(move || {
        Ok((extractor_config::read(&root), storage::read_consent(&root)))
    })
    .await?;
    if consent.mode == ProfilingMode::Off {
        let stable = stable_count(&dependencies).await?;
        return Ok(base(
            false,
            consent.mode,
            source,
            None,
            model_config,
            stable,
        ));
    }
    let normalized = normalize_text(&options.text);
    let hash = import_hash(&source, &normalized);
    let import_id = format!("third_party_profile_import:{source}:{hash}");
    if normalized.is_empty() {
        let stable = stable_count(&dependencies).await?;
        return Ok(base(
            true,
            consent.mode,
            source,
            Some(import_id),
            model_config,
            stable,
        ));
    }
    let model = options
        .model
        .as_deref()
        .map(crate::public_text::trim_js_whitespace)
        .filter(|value| !value.is_empty())
        .map(|value| crate::models::parse_model_ref(value).canonical_ref)
        .unwrap_or_else(|| model_config.effective_model.clone());
    model_config.effective_model = model.clone();
    let imported_at = match options.now_epoch_millis {
        Some(value) => crate::js_date::format_date_value(value).ok_or_else(|| {
            ProfileError::new("profile_data_invalid", "Profile import time is invalid.")
        })?,
        None => dependencies.host.now_iso(),
    };
    let mut instructions = prompt::instructions(consent.mode);
    instructions.push_str("\nThe input is a user-provided export from another AI assistant, not a Butler transcript.\nTreat claims as third-party imported profile candidates. Prefer source_type inference unless the export clearly says the user explicitly stated or confirmed the point.\nDo not copy raw import text into summaries.");
    let prompt = import_prompt(&source, &import_id, &normalized, consent.mode, &imported_at)?;
    let attachments = [];
    let root_text = dependencies.root.to_string_lossy().into_owned();
    let request = ProviderPromptRequest {
        prompt: &prompt,
        model: Some(&model),
        reasoning_effort: Some(&runtime::reasoning(&model_config.reasoning_effort)),
        instructions: Some(&instructions),
        response_format: None,
        cache_scope: Some("profile-extractor"),
        cache_boundary: None,
        cancellation: cancellation.clone(),
        attachments: &attachments,
        butler_data: Some(&root_text),
        usage_attribution: None,
        stream_observer: None,
        provider_retry_attempts: None,
    };
    let response = dependencies
        .provider
        .run_prompt(request, ProviderPromptLifecycle::none())
        .await
        .map_err(|_| {
            ProfileError::new(
                "profile_model_failed",
                "Profile extractor model runner failed",
            )
        })?;
    let allowed = HashSet::from([import_id.clone()]);
    let extracted = parser::forgiving(&response.text, &allowed, consent.mode);
    let mut ids = HashSet::new();
    for candidate in extracted {
        let root = dependencies.root.clone();
        let now = options
            .now_epoch_millis
            .map(|_| imported_at.clone())
            .unwrap_or_else(|| dependencies.host.now_iso());
        let evidence = import_id.clone();
        let record = runtime::blocking(move || {
            candidates::upsert(
                &root,
                &ProfileCandidateInput {
                    category: candidate.category,
                    payload: candidate.payload,
                    source_type: candidate.source_type,
                    confidence: candidate.confidence,
                    sensitive_domain: candidate.sensitive_domain,
                    evidence_ref: Some(evidence),
                    evidence_observed_at: None,
                    expires_or_decay: candidate.expires_or_decay,
                },
                &now,
            )
        })
        .await?;
        if let Some(record) = record {
            ids.insert(record.id);
        }
    }
    let mut candidate_ids = ids.iter().cloned().collect::<Vec<_>>();
    candidate_ids.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
    let manifest = json!({"import_id":import_id,"source":source,"imported_at":imported_at,"text_sha256":hash,"input_chars":normalized.len_utf16(),"candidate_ids":candidate_ids,"raw_text_included":false});
    runtime::blocking({
        let root = dependencies.root.clone();
        let hash = hash.clone();
        move || write_manifest(&root, &hash, &manifest)
    })
    .await?;
    let consolidation = runtime::with_gate(&dependencies, None, {
        let root = dependencies.root.clone();
        let sources = dependencies.sources.clone();
        let now = dependencies.host.now_iso();
        let now_ms = dependencies.host.now_epoch_millis();
        move || candidates::consolidate(&root, sources.as_ref(), consent.mode, &now, now_ms)
    })
    .await?;
    Ok(ProfileThirdPartyImportResult {
        profiling_enabled: true,
        mode: consent.mode,
        source,
        import_id: Some(import_id),
        imported_candidate_count: ids.len(),
        promoted_count: consolidation.promoted_count,
        skipped_count: consolidation.skipped_count,
        stable_entry_count: consolidation.stable_entry_count,
        projection_written: consolidation.projection_written,
        raw_text_included: false,
        extractor_model: model_config,
        model_called: true,
        fallback_used: false,
        model_error: None,
    })
}

async fn stable_count(dependencies: &Dependencies) -> ProfileResult<usize> {
    let root = dependencies.root.clone();
    runtime::blocking(move || Ok(storage::stable_entries(&root)?.len())).await
}

fn normalize_text(value: &str) -> Utf16Prefix<'static> {
    let normalized = value.replace("\r\n", "\n");
    let trimmed = crate::public_text::trim_js_whitespace(&normalized).to_owned();
    Utf16Prefix::new(trimmed, 60_000)
}
fn normalize_source(value: Option<&str>) -> String {
    let value = value
        .map(crate::public_text::trim_js_whitespace)
        .unwrap_or("")
        .to_lowercase();
    let mut output = String::new();
    let mut dash = false;
    for character in value.chars() {
        if character.is_ascii_lowercase()
            || character.is_ascii_digit()
            || matches!(character, '_' | '-')
        {
            output.push(character);
            dash = false;
        } else if !dash {
            output.push('-');
            dash = true;
        }
    }
    let output = output.trim_matches('-');
    if output.is_empty() {
        "external-ai".into()
    } else {
        output.into()
    }
}
fn import_hash(source: &str, text: &Utf16Prefix<'_>) -> String {
    let mut hash = Sha256::new();
    hash.update(source);
    hash.update(b"\n");
    hash.update(text.utf8_for_hash().as_bytes());
    format!("{:x}", hash.finalize())[..16].into()
}
fn import_prompt(
    source: &str,
    id: &str,
    text: &Utf16Prefix<'_>,
    mode: ProfilingMode,
    now: &str,
) -> ProfileResult<String> {
    let literal = text
        .collapse_whitespace(crate::public_text::is_js_whitespace)
        .prefix(18_000)
        .json_literal()
        .map_err(|_| ProfileError::new("profile_data_invalid", "Profile data is invalid."))?;
    Ok(format!(
        "Profiling mode: {}\nImport source: {source}\nImport ref: {id}\nImported at: {now}\n\nAnalyze this third-party assistant export and return profile candidates as JSON.\nEvery evidence_refs item must be exactly the Import ref above.\nDo not preserve or quote raw import text.\n\nImported export:\n{literal}",
        mode.as_str()
    ))
}
fn write_manifest(root: &Path, hash: &str, value: &Value) -> ProfileResult<()> {
    let directory = root.join("personalization/profile-imports");
    create_private_directory(&directory).map_err(|_| {
        ProfileError::new("profile_store_unavailable", "Profile store is unavailable.")
    })?;
    let mut bytes = serde_json::to_string_pretty(value)
        .map_err(|_| ProfileError::new("profile_data_invalid", "Profile data is invalid."))?;
    bytes.push('\n');
    let path = directory.join(format!("{hash}.json"));
    let mut file = private_manifest_file(&path).map_err(|_| {
        ProfileError::new("profile_store_unavailable", "Profile store is unavailable.")
    })?;
    file.write_all(bytes.as_bytes()).map_err(|_| {
        ProfileError::new("profile_store_unavailable", "Profile store is unavailable.")
    })
}

fn create_private_directory(path: &Path) -> std::io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)
}

fn private_manifest_file(path: &Path) -> std::io::Result<fs::File> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err(std::io::Error::other("manifest path is a symlink"));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(nix::libc::O_NOFOLLOW);
    }
    options.open(path)
}
fn base(
    enabled: bool,
    mode: ProfilingMode,
    source: String,
    id: Option<String>,
    model: ProfilingExtractorModelSnapshot,
    stable: usize,
) -> ProfileThirdPartyImportResult {
    ProfileThirdPartyImportResult {
        profiling_enabled: enabled,
        mode,
        source,
        import_id: id,
        imported_candidate_count: 0,
        promoted_count: 0,
        skipped_count: 0,
        stable_entry_count: stable,
        projection_written: false,
        raw_text_included: false,
        extractor_model: model,
        model_called: false,
        fallback_used: false,
        model_error: None,
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use serde_json::Value;

    use super::*;

    #[test]
    fn persisted_import_normalization_hash_and_id_are_stable() {
        let golden: Value =
            serde_json::from_str(include_str!("../tests/identity-golden.json")).unwrap();
        let source = normalize_source(Some(" Other Assistant! "));
        let text = normalize_text("  First\r\nsecond\t🙂  ");
        let hash = import_hash(&source, &text);
        let id = format!("third_party_profile_import:{source}:{hash}");
        assert_eq!(source, golden["source"]);
        assert_eq!(text.utf8_for_hash(), golden["normalized"].as_str().unwrap());
        assert_eq!(hash, golden["importHash"]);
        assert_eq!(id, golden["importId"]);
    }

    #[cfg(unix)]
    #[test]
    fn manifest_writer_rejects_final_symlink_and_truncates_regular_reimports() {
        use std::{fs, os::unix::fs::symlink};

        let root = std::env::temp_dir().join(format!(
            "butler-profile-import-manifest-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let target = root.join("outside.json");
        let manifest = root.join("hash.json");
        fs::write(&target, b"outside data").unwrap();
        symlink(&target, &manifest).unwrap();

        assert!(private_manifest_file(&manifest).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"outside data");

        fs::remove_file(&manifest).unwrap();
        fs::write(&manifest, b"prior manifest").unwrap();
        let mut file = private_manifest_file(&manifest).unwrap();
        file.write_all(b"updated manifest").unwrap();
        drop(file);
        assert_eq!(fs::read(&manifest).unwrap(), b"updated manifest");
        fs::remove_dir_all(root).unwrap();
    }
}
