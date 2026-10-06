//! Site-only HTTPS fetches with pinned DNS and bounded reads.
use super::{Icon, policy};
use reqwest::{Client, Response, Url, redirect::Policy};
use std::time::Duration;

pub(super) const ICON_LIMIT: usize = 100 * 1024;
const HEAD_LIMIT: usize = 512 * 1024;

pub(super) async fn fetch(host: &str) -> Option<Icon> {
    tokio::time::timeout(Duration::from_millis(3500), fetch_site(host))
        .await
        .ok()
        .flatten()
}

async fn fetch_site(host: &str) -> Option<Icon> {
    let root = Url::parse(&format!("https://{host}/")).ok()?;
    if let Some((head, final_url)) = request(root.clone(), host, HEAD_LIMIT, true).await {
        for url in declared_icons(&head, &final_url) {
            if let Some(icon) = fetch_icon(url, host).await {
                return Some(icon);
            }
        }
    }
    fetch_icon(root.join("/favicon.ico").ok()?, host).await
}

async fn fetch_icon(url: Url, host: &str) -> Option<Icon> {
    let (bytes, _) = request(url, host, ICON_LIMIT, false).await?;
    Icon::new(bytes)
}

async fn request(mut url: Url, site: &str, cap: usize, head: bool) -> Option<(Vec<u8>, Url)> {
    for hop in 0..=3 {
        let host = url.host_str()?;
        // Icons, pages and redirects cannot send browsing history to another site.
        if url.scheme() != "https"
            || host != site
            || !policy::valid_host(host)
            || !url.username().is_empty()
            || url.password().is_some()
            || url.port_or_known_default() != Some(443)
        {
            return None;
        }
        let addresses: Vec<_> = tokio::net::lookup_host((host, 443)).await.ok()?.collect();
        if addresses.is_empty() || addresses.iter().any(|addr| !policy::public_ip(addr.ip())) {
            return None;
        }
        let host = host.to_owned();
        // Native trust-store loading may read files; keep it off Tokio workers.
        let client = tokio::task::spawn_blocking(move || {
            Client::builder()
                .no_proxy()
                .redirect(Policy::none())
                .connect_timeout(Duration::from_secs(2))
                .user_agent("Mozilla/5.0")
                .resolve_to_addrs(&host, &addresses)
                .build()
        })
        .await
        .ok()?
        .ok()?;
        let response = client
            .get(url.clone())
            .header("Accept", "image/*")
            .send()
            .await
            .ok()?;
        if response.status().is_redirection() {
            if hop == 3 {
                return None;
            }
            url = url
                .join(response.headers().get("location")?.to_str().ok()?)
                .ok()?;
            continue;
        }
        if !response.status().is_success() {
            return None;
        }
        return Some((read(response, cap, head).await?, url));
    }
    None
}

async fn read(mut response: Response, cap: usize, head: bool) -> Option<Vec<u8>> {
    if !head
        && response
            .content_length()
            .is_some_and(|size| size > cap as u64)
    {
        return None;
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.ok()? {
        if head {
            let search_start = bytes.len().saturating_sub(6);
            bytes.extend_from_slice(&chunk[..chunk.len().min(cap - bytes.len())]);
            if let Some(end) = bytes[search_start..]
                .windows(7)
                .position(|part| part.eq_ignore_ascii_case(b"</head>"))
            {
                bytes.truncate(search_start + end + 7);
                return Some(bytes);
            }
            if bytes.len() == cap {
                return Some(bytes);
            }
        } else {
            if bytes.len() + chunk.len() > cap {
                return None;
            }
            bytes.extend_from_slice(&chunk);
        }
    }
    Some(bytes)
}

fn declared_icons(head: &[u8], base: &Url) -> Vec<Url> {
    // Parse attributes rather than trusting MIME declarations; sniff the downloaded raster.
    let Ok(links) = regex::Regex::new(r"(?is)<link\b[^>]*>") else {
        return vec![];
    };
    let Ok(attrs) = regex::Regex::new(r#"(?is)([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))"#)
    else {
        return vec![];
    };
    let text = String::from_utf8_lossy(head);
    let mut icons = Vec::new();
    for link in links.find_iter(&text) {
        let mut values = std::collections::HashMap::new();
        for attr in attrs.captures_iter(link.as_str()) {
            if let Some(value) = attr.get(2).or_else(|| attr.get(3)).or_else(|| attr.get(4)) {
                values.insert(attr[1].to_ascii_lowercase(), value.as_str());
            }
        }
        let rel = values
            .get("rel")
            .copied()
            .unwrap_or("")
            .to_ascii_lowercase();
        if !rel
            .split_whitespace()
            .any(|v| v == "icon" || v == "apple-touch-icon")
        {
            continue;
        }
        let Some(url) = values.get("href").and_then(|href| base.join(href).ok()) else {
            continue;
        };
        let preferred = values.get("type").is_some_and(|mime| {
            [
                "image/png",
                "image/x-icon",
                "image/vnd.microsoft.icon",
                "image/webp",
            ]
            .iter()
            .any(|accepted| mime.eq_ignore_ascii_case(accepted))
        }) || ["png", "ico", "webp"]
            .iter()
            .any(|ext| url.path().to_ascii_lowercase().ends_with(ext));
        let distance = values
            .get("sizes")
            .into_iter()
            .flat_map(|sizes| sizes.split_whitespace())
            .filter_map(|size| size.split_once('x')?.0.parse::<u32>().ok())
            .map(|size| {
                if size < 32 {
                    32 - size
                } else {
                    size.saturating_sub(64)
                }
            })
            .min()
            .unwrap_or(0);
        icons.push((!preferred, distance, url));
    }
    icons.sort_by_key(|(other, distance, _)| (*other, *distance));
    icons.into_iter().map(|(_, _, url)| url).collect()
}
