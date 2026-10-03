//! Resolve releases at check time. Only saved status reads use the six-hour cache.
use super::{UpdateCode, UpdateError, manifest::read_manifest};
use serde_json::Value;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::OnceLock,
    time::SystemTime,
};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

type Preferences = HashMap<PathBuf, (Option<(SystemTime, u64)>, bool)>;
static PREFERENCES: OnceLock<Mutex<Preferences>> = OnceLock::new();
const RELEASE_PREFIX: &str = "https://github.com/Hexpy-Games/butler/releases/latest/download/";

pub(super) async fn previews(data: &Path, channel: Option<&str>) -> bool {
    if let Some(channel) = channel {
        return channel == "preview";
    }
    let path = data.join("butler.config.json");
    let stamp = tokio::fs::metadata(&path)
        .await
        .ok()
        .and_then(|meta| meta.modified().ok().map(|at| (at, meta.len())));
    let mut cache = PREFERENCES
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .await;
    if let Some((_, enabled)) = cache.get(&path).filter(|(prior, _)| *prior == stamp) {
        return *enabled;
    }
    let enabled = tokio::fs::read(&path)
        .await
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|config| config.pointer("/update/previews").and_then(Value::as_bool))
        .unwrap_or(false);
    cache.insert(path, (stamp, enabled));
    enabled
}

pub(super) fn eligible(value: &Value, previews: bool) -> bool {
    value
        .get("version")
        .and_then(Value::as_str)
        .and_then(|version| semver::Version::parse(version).ok())
        .is_some_and(|version| previews || version.pre.is_empty())
}

pub(super) fn newest<'a>(items: impl Iterator<Item = &'a Value>) -> Option<&'a Value> {
    items.max_by(|a, b| {
        let parse = |v: &Value| {
            v["version"]
                .as_str()
                .and_then(|s| semver::Version::parse(s).ok())
        };
        match (parse(a), parse(b)) {
            (Some(a), Some(b)) => a.cmp_precedence(&b),
            _ => std::cmp::Ordering::Equal,
        }
    })
}

/// Stable uses GitHub's latest release. Preview lists published releases and
/// selects by SemVer, independently of publication date and prerelease numbering.
pub(super) async fn source(
    client: &reqwest::Client,
    shutdown: &CancellationToken,
    source: &str,
    previews: bool,
) -> Result<String, UpdateError> {
    let api_override = std::env::var("BUTLER_UPDATE_RELEASES_API")
        .ok()
        .filter(|api| !api.trim().is_empty());
    let Some(asset) = source
        .strip_prefix(RELEASE_PREFIX)
        .filter(|_| previews || api_override.is_some())
    else {
        return Ok(source.to_owned());
    };
    let api = api_override
        .unwrap_or_else(|| "https://api.github.com/repos/Hexpy-Games/butler/releases".into());
    if !previews {
        let body = read_manifest(client, shutdown, &format!("{api}/latest")).await?;
        let release: Value = serde_json::from_slice(&body)
            .map_err(|e| UpdateError::caused(UpdateCode::UpdateManifestInvalid, e))?;
        return download_url(&release, asset)
            .map(str::to_owned)
            .ok_or(UpdateCode::UpdateManifestUnavailable.into());
    }
    let mut best: Option<(semver::Version, String)> = None;
    let mut page = 1;
    loop {
        let url = format!("{api}?per_page=20&page={page}");
        let body = read_manifest(client, shutdown, &url).await?;
        let releases: Vec<Value> = serde_json::from_slice(&body)
            .map_err(|e| UpdateError::caused(UpdateCode::UpdateManifestInvalid, e))?;
        for release in &releases {
            if release["draft"] == true {
                continue;
            }
            let Some(version) = release["tag_name"]
                .as_str()
                .and_then(|s| semver::Version::parse(s.trim_start_matches('v')).ok())
            else {
                continue;
            };
            let download = download_url(release, asset);
            if let Some(download) = download
                && best
                    .as_ref()
                    .is_none_or(|(prior, _)| version.cmp_precedence(prior).is_gt())
            {
                best = Some((version, download.to_owned()));
            }
        }
        if releases.len() < 20 {
            break;
        }
        page += 1;
    }
    let (_, url) = best.ok_or(UpdateCode::UpdateManifestUnavailable)?;
    Ok(url)
}

fn download_url<'a>(release: &'a Value, asset: &str) -> Option<&'a str> {
    release["assets"]
        .as_array()?
        .iter()
        .find(|value| value["name"].as_str() == Some(asset))?["browser_download_url"]
        .as_str()
}
