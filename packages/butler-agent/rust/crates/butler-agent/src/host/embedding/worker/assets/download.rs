//! Bounded source failover and verified Range continuation.
use super::{Asset, matches_asset};
use futures_util::StreamExt;
use reqwest::{Client, StatusCode, header};
use std::{
    fs::{self, File},
    io::Write,
    path::Path,
    time::Duration,
};

pub(super) async fn with_retries(
    client: &Client,
    sources: &[String],
    asset: &Asset,
    part: &Path,
    baseline: u64,
    progress: &mut impl FnMut(&str, u64),
) -> Result<(), &'static str> {
    if std::env::var("BUTLER_E2E_TIER").as_deref() == Ok("stub")
        && !sources.iter().all(|source| {
            reqwest::Url::parse(source)
                .is_ok_and(|url| url.scheme() == "http" && url.host_str() == Some("127.0.0.1"))
        })
    {
        eprintln!(
            "embed_asset_real_download_forbidden_in_stub: BUTLER_E2E_TIER=stub requires \
             local BUTLER_E2E_EMBED_SOURCES or BUTLER_E2E_EMBED_MANIFEST; \
             supply cached assets with BUTLER_E2E_EMBEDDING_ASSETS"
        );
        return Err("embed_asset_real_download_forbidden_in_stub");
    }
    let mut failure = "embed_asset_download_failed";
    for attempt in 0..3 {
        for (index, source) in sources.iter().enumerate() {
            let relative = if index == 0 {
                asset.relative.as_str()
            } else {
                asset.relative.rsplit('/').next().unwrap_or(&asset.relative)
            };
            let url = format!("{source}/{relative}");
            match download(client, &url, asset, part, baseline, progress).await {
                Ok(()) => return Ok(()),
                Err(error) => failure = error,
            }
        }
        if attempt < 2 {
            tokio::time::sleep(Duration::from_secs(1 << attempt)).await;
        }
    }
    Err(failure)
}

async fn download(
    client: &Client,
    url: &str,
    asset: &Asset,
    part: &Path,
    baseline: u64,
    progress: &mut impl FnMut(&str, u64),
) -> Result<(), &'static str> {
    let mut start = fs::metadata(part).map_or(0, |meta| meta.len());
    if start >= asset.bytes && part.exists() {
        progress("verifying", baseline + start.min(asset.bytes));
        if matches_asset(part, asset)? {
            return Ok(());
        }
        fs::remove_file(part).map_err(|_| "embed_asset_unavailable")?;
        start = 0;
    }
    progress("downloading", baseline + start);
    let mut request = client.get(url).header(header::ACCEPT_ENCODING, "identity");
    if start > 0 {
        request = request.header(header::RANGE, format!("bytes={start}-"));
    }
    let response = request
        .send()
        .await
        .map_err(|_| "embed_asset_download_failed")?;
    if start > 0 && response.status() == StatusCode::PARTIAL_CONTENT {
        if !valid_range(response.headers(), start, asset.bytes) {
            return Err("embed_asset_range_invalid");
        }
    } else if response.status() == StatusCode::OK {
        // A source may ignore Range. Its complete response safely replaces the partial.
        start = 0;
    } else {
        return Err("embed_asset_download_failed");
    }
    let mut file = File::options()
        .create(true)
        .write(true)
        .append(start > 0)
        .truncate(start == 0)
        .open(part)
        .map_err(|_| "embed_asset_unavailable")?;
    let mut received = start;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = tokio::time::timeout(Duration::from_secs(30), stream.next())
        .await
        .map_err(|_| "embed_asset_download_failed")?
    {
        let chunk = chunk.map_err(|_| "embed_asset_download_failed")?;
        received = received
            .checked_add(chunk.len() as u64)
            .filter(|count| *count <= asset.bytes)
            .ok_or("embed_asset_download_failed")?;
        file.write_all(&chunk)
            .map_err(|_| "embed_asset_unavailable")?;
        progress("downloading", baseline + received);
    }
    if received != asset.bytes {
        return Err("embed_asset_download_failed");
    }
    file.sync_all().map_err(|_| "embed_asset_unavailable")?;
    drop(file);
    progress("verifying", baseline + received);
    if !matches_asset(part, asset)? {
        fs::remove_file(part).map_err(|_| "embed_asset_unavailable")?;
        return Err("embed_asset_hash_mismatch");
    }
    Ok(())
}

fn valid_range(headers: &header::HeaderMap, start: u64, total: u64) -> bool {
    let Some(raw) = headers
        .get(header::CONTENT_RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("bytes "))
    else {
        return false;
    };
    let Some((range, length)) = raw.split_once('/') else {
        return false;
    };
    let Some((first, last)) = range.split_once('-') else {
        return false;
    };
    matches!((first.parse::<u64>(), last.parse::<u64>(), length.parse::<u64>()),
        (Ok(first), Ok(last), Ok(length)) if first == start && last == total - 1 && length == total)
}
