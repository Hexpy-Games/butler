use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::contracts::{
    PersonalizationProfile, PersonalizationProfileUpdate, ProfileError, ProfileResult,
};

const TEXT_LIMIT: usize = 256;

pub(super) fn path(data_root: &Path) -> PathBuf {
    data_root.join("personalization/profile.json")
}

pub(super) fn read(data_root: &Path) -> PersonalizationProfile {
    let Ok(bytes) = fs::read(path(data_root)) else {
        return PersonalizationProfile::default();
    };
    let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
        return PersonalizationProfile::default();
    };
    PersonalizationProfile {
        butler_nickname: field(&value, "butler_nickname"),
        principal_name: field(&value, "principal_name"),
        preferred_address: field(&value, "preferred_address"),
        updated_at: value
            .get("updated_at")
            .and_then(Value::as_str)
            .map(str::to_owned),
    }
}

pub(super) fn update(
    data_root: &Path,
    input: &PersonalizationProfileUpdate,
    now_iso: &str,
    pid: u32,
    now_ms: i64,
) -> ProfileResult<PersonalizationProfile> {
    let mut next = read(data_root);
    if let Some(value) = &input.butler_nickname {
        next.butler_nickname = bounded(value, TEXT_LIMIT);
    }
    if let Some(value) = &input.principal_name {
        next.principal_name = bounded(value, TEXT_LIMIT);
    }
    if let Some(value) = &input.preferred_address {
        next.preferred_address = bounded(value, TEXT_LIMIT);
    }
    next.updated_at = Some(now_iso.to_owned());
    atomic_json(&path(data_root), &next, pid, now_ms)?;
    Ok(next)
}

pub(super) fn render(profile: &PersonalizationProfile) -> Option<String> {
    let mut rows = Vec::new();
    if !profile.butler_nickname.is_empty() {
        rows.push(format!("- Butler nickname: {}", profile.butler_nickname));
    }
    if !profile.principal_name.is_empty() {
        rows.push(format!("- Principal name: {}", profile.principal_name));
    }
    if !profile.preferred_address.is_empty() {
        rows.push(format!(
            "- Address the principal as: {}",
            profile.preferred_address
        ));
    }
    (!rows.is_empty()).then(|| format!(
        "# Personalization Profile\n\n{}\n\nUse these naming preferences naturally. Do not force the address into every message.",
        rows.join("\n")
    ))
}

pub(super) fn bounded(value: &str, limit: usize) -> String {
    let normalized = value.replace("\r\n", "\n");
    let normalized = crate::public_text::trim_js_whitespace(&normalized);
    if normalized.encode_utf16().count() <= limit {
        return normalized.to_owned();
    }
    let mut units = 0;
    normalized
        .chars()
        .take_while(|character| {
            let next = units + character.len_utf16();
            if next > limit {
                false
            } else {
                units = next;
                true
            }
        })
        .collect()
}

pub(super) fn collapse_js_whitespace(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut pending_space = false;
    for character in value.chars() {
        if crate::public_text::is_js_whitespace(character) {
            pending_space = !output.is_empty();
        } else {
            if pending_space {
                output.push(' ');
                pending_space = false;
            }
            output.push(character);
        }
    }
    output
}

pub(super) fn atomic_json<T: serde::Serialize>(
    path: &Path,
    value: &T,
    pid: u32,
    now_ms: i64,
) -> ProfileResult<()> {
    let parent = path.parent().ok_or_else(write_error)?;
    fs::create_dir_all(parent).map_err(|_| write_error())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(parent, fs::Permissions::from_mode(0o700));
    }
    let temporary = PathBuf::from(format!("{}.{}.{}.tmp", path.display(), pid, now_ms));
    let mut bytes = serde_json::to_vec_pretty(value)
        .map_err(|_| ProfileError::new("profile_write_failed", "Profile could not be written."))?;
    bytes.push(b'\n');
    let result = (|| {
        #[cfg(unix)]
        {
            use std::io::Write;
            use std::os::unix::fs::OpenOptionsExt;
            let mut file = fs::OpenOptions::new()
                .create(true)
                .truncate(true)
                .write(true)
                .mode(0o600)
                .open(&temporary)?;
            file.write_all(&bytes)?;
        }
        #[cfg(not(unix))]
        fs::write(&temporary, &bytes)?;
        fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map_err(|_| write_error())
}

fn field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(|value| bounded(value, TEXT_LIMIT))
        .unwrap_or_default()
}
fn write_error() -> ProfileError {
    ProfileError::new("profile_write_failed", "Profile could not be written.")
}
