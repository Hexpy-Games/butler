//! Channel selection at check time; status reads use the existing six-hour cache.
use super::{UpdateCode, UpdateError, manifest::read_manifest};
use serde_json::Value;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::OnceLock,
    time::{Duration, Instant, SystemTime},
};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

type Cache = HashMap<(String, bool), (Instant, String)>;
type Preferences = HashMap<PathBuf, (Option<(SystemTime, u64)>, bool)>;
static PREFERENCES: OnceLock<Mutex<Preferences>> = OnceLock::new();
static RELEASES: OnceLock<Mutex<Cache>> = OnceLock::new();
const CACHE_AGE: Duration = Duration::from_secs(6 * 60 * 60);
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
    let Some(asset) = source.strip_prefix(RELEASE_PREFIX).filter(|_| previews) else {
        return Ok(source.to_owned());
    };
    let mut cache = RELEASES
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .await;
    let key = (asset.to_owned(), previews);
    if let Some((_, url)) = cache.get(&key).filter(|(at, _)| at.elapsed() < CACHE_AGE) {
        return Ok(url.clone());
    }
    let mut best: Option<(semver::Version, String)> = None;
    let mut page = 1;
    loop {
        let url = format!(
            "https://api.github.com/repos/Hexpy-Games/butler/releases?per_page=20&page={page}"
        );
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
            let download = release["assets"]
                .as_array()
                .and_then(|assets| assets.iter().find(|v| v["name"].as_str() == Some(asset)))
                .and_then(|v| v["browser_download_url"].as_str());
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
    cache.insert(key, (Instant::now(), url.clone()));
    Ok(url)
}
