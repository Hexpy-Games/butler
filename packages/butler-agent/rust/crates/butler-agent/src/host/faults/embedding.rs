//! Local asset fixtures for the explicitly selected fault build.
use serde::Deserialize;

#[derive(Deserialize)]
pub(in crate::host) struct Asset {
    pub relative: String,
    pub bytes: u64,
    pub sha256: String,
}
#[derive(Deserialize)]
pub(in crate::host) struct Manifest {
    pub assets: Vec<Asset>,
    pub sources: Vec<String>,
}

fn local_source(source: &str) -> bool {
    reqwest::Url::parse(source)
        .is_ok_and(|url| url.scheme() == "http" && url.host_str() == Some("127.0.0.1"))
}

pub(in crate::host) fn embedding_manifest(pinned: &[&str]) -> Option<Manifest> {
    let raw = std::env::var("BUTLER_E2E_EMBED_MANIFEST").ok()?;
    let value = serde_json::from_str::<Manifest>(&raw).ok()?;
    (value.assets.len() == pinned.len()
        && value.assets.iter().zip(pinned).all(|(asset, relative)| {
            asset.relative == *relative && asset.bytes > 0 && asset.bytes < 1024 * 1024
        })
        && !value.sources.is_empty()
        && value.sources.iter().all(|source| local_source(source)))
    .then_some(value)
}

pub(in crate::host) fn embedding_sources() -> Option<Vec<String>> {
    std::env::var("BUTLER_E2E_EMBED_SOURCES")
        .ok()
        .filter(|source| local_source(source))
        .map(|source| vec![source])
}

/// The harness opts into local-only acquisition independently of its test tier.
pub(in crate::host) fn local_asset_sources(sources: &[String]) -> Result<(), &'static str> {
    if std::env::var("BUTLER_E2E_EMBED_LOCAL_ONLY").as_deref() == Ok("1")
        && !sources.iter().all(|source| local_source(source))
    {
        eprintln!(
            "embed_asset_real_download_forbidden_in_stub: BUTLER_E2E_EMBED_LOCAL_ONLY=1 requires \
             local BUTLER_E2E_EMBED_SOURCES or BUTLER_E2E_EMBED_MANIFEST; \
             supply cached assets with BUTLER_E2E_EMBEDDING_ASSETS"
        );
        return Err("embed_asset_real_download_forbidden_in_stub");
    }
    Ok(())
}
