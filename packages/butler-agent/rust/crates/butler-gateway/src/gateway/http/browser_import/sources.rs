//! Detected sources and owner-picked folders. Private paths never enter source listings.
use super::{HttpError, HttpState, blocking, failure, native_error};
use butler_platform::browser_profiles::{self, BrowserProfile, ProfileAccess};
use serde_json::{Value, json};
use std::sync::Arc;

pub(super) async fn list(state: &Arc<HttpState>) -> Result<Value, HttpError> {
    let mut profiles = blocking(browser_profiles::detect).await?;
    let folders = state.browser_import.folders.lock().await;
    profiles.retain(|p| {
        !(p.id == "blocked" && folders.values().any(|picked| picked.browser == p.browser))
    });
    for (key, profile) in folders.iter() {
        profiles.retain(|p| source_key(p) != *key);
        profiles.push(profile.clone());
    }
    let sources: Vec<Value> = profiles
        .iter()
        .map(|p| {
            json!({"key":source_key(p),"browser":p.browser,"name":p.name,
        "permission":if p.access == ProfileAccess::PermissionDenied { "denied" } else { "ready" },
        "passwords":butler_platform::browser_transfer::password_mode(p)})
        })
        .collect();
    Ok(json!({"sources":sources}))
}
pub(super) fn source_key(profile: &BrowserProfile) -> String {
    format!("{}:{}", profile.browser, profile.id)
}

pub(super) async fn resolve(
    state: &Arc<HttpState>,
    source: &str,
) -> Result<BrowserProfile, HttpError> {
    if let Some(profile) = state
        .browser_import
        .folders
        .lock()
        .await
        .get(source)
        .cloned()
    {
        return Ok(profile);
    }
    let key = source.to_owned();
    blocking(move || {
        browser_profiles::detect()
            .into_iter()
            .find(|p| source_key(p) == key)
    })
    .await?
    .ok_or_else(|| failure("import_not_found"))
}

pub(super) async fn pick(state: &Arc<HttpState>, body: &Value) -> Result<Value, HttpError> {
    let source = body["source"]
        .as_str()
        .ok_or_else(|| failure("import_not_found"))?;
    let profile = resolve(state, source).await?;
    let picked = blocking(move || {
        let Some(folder) = butler_platform::browser_transfer::pick_folder() else {
            return Ok(None);
        };
        browser_profiles::picked_profiles(profile, &folder)
            .map(Some)
            .map_err(|e| butler_platform::browser_transfer::io_error(&e))
    })
    .await?
    .map_err(native_error)?;
    if let Some(profiles) = picked {
        let selected = profiles.first().map(source_key);
        let mut folders = state.browser_import.folders.lock().await;
        for profile in profiles {
            folders.insert(source_key(&profile), profile);
        }
        Ok(json!({"selected":true,"source":selected}))
    } else {
        Ok(json!({"selected":false}))
    }
}

pub(super) fn bookmarks(
    profile: &BrowserProfile,
    scratch: &std::path::Path,
) -> Result<Vec<butler_runtime::browser_import::Bookmark>, HttpError> {
    use browser_profiles::BookmarkFormat as F;
    use butler_runtime::browser_import as import;
    if profile.access == ProfileAccess::PermissionDenied {
        return Err(failure("full_disk_access_required"));
    }
    let path = &profile.bookmarks;
    if !path
        .try_exists()
        .map_err(|e| native_error(butler_platform::browser_transfer::io_error(&e)))?
    {
        return Ok(Vec::new());
    }
    let items = match profile.format {
        F::Chromium => import::chromium(
            &butler_platform::browser_transfer::read(path, import::MAX_BOOKMARK_BYTES)
                .map_err(native_error)?,
        ),
        F::Firefox => import::firefox(path, scratch),
        F::Safari => import::safari(
            &browser_profiles::read_safari_bookmarks(path)
                .map_err(|e| native_error(butler_platform::browser_transfer::io_error(&e)))?,
        ),
    };
    items
        .and_then(import::finish)
        .map_err(|e| super::import_error(&e))
}
