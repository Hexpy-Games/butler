//! Resource bytes through the page's CEF session, with the snapshot network boundary.
use super::reader;
use crate::ui::browser::{engine::TabId, model::BrowserState};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use gpui::AsyncApp;
use serde_json::json;
use std::net::{IpAddr, ToSocketAddrs as _};

pub(super) struct Asset {
    pub(super) mime: String,
    pub(super) bytes: Vec<u8>,
}
impl Asset {
    pub(super) fn data_url(&self) -> String {
        format!("data:{};base64,{}", self.mime, STANDARD.encode(&self.bytes))
    }
}
fn private(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, _, _] = ip.octets();
            a == 0
                || a == 10
                || a == 127
                || a >= 224
                || (a == 169 && b == 254)
                || (a == 172 && (16..=31).contains(&b))
                || (a == 192 && b == 168)
                || (a == 100 && (64..=127).contains(&b))
        }
        IpAddr::V6(ip) => ip.to_ipv4_mapped().map_or_else(
            || {
                ip.is_loopback()
                    || ip.is_unspecified()
                    || ip.is_unique_local()
                    || ip.is_unicast_link_local()
                    || ip.is_multicast()
            },
            |v| private(v.into()),
        ),
    }
}
fn local(url: &url::Url) -> bool {
    match url.host() {
        Some(url::Host::Ipv4(ip)) => private(ip.into()),
        Some(url::Host::Ipv6(ip)) => private(ip.into()),
        Some(url::Host::Domain(host)) => host == "localhost" || host.ends_with(".localhost"),
        None => false,
    }
}

async fn allowed(url: &url::Url, origins: &[String], cx: &AsyncApp) -> anyhow::Result<()> {
    anyhow::ensure!(
        matches!(url.scheme(), "http" | "https")
            && url.username().is_empty()
            && url.password().is_none(),
        "invalid resource URL"
    );
    if origins
        .iter()
        .any(|o| *o == url.origin().ascii_serialization())
        || origins
            .iter()
            .all(|o| url::Url::parse(o).is_ok_and(|u| local(&u)))
    {
        return Ok(());
    }
    let host = url
        .host_str()
        .ok_or_else(|| anyhow::anyhow!("missing resource host"))?
        .to_owned();
    let port = url
        .port_or_known_default()
        .ok_or_else(|| anyhow::anyhow!("missing port"))?;
    let safe = cx
        .background_executor()
        .spawn(async move {
            (host.as_str(), port).to_socket_addrs().map(|addresses| {
                let addresses: Vec<_> = addresses.collect();
                !addresses.is_empty() && addresses.iter().all(|a| !private(a.ip()))
            })
        })
        .await?;
    anyhow::ensure!(safe, "private snapshot resource");
    Ok(())
}
pub(super) async fn fetch(
    page: &TabId,
    source: &str,
    origins: &[String],
    cx: &AsyncApp,
) -> anyhow::Result<Asset> {
    let url = url::Url::parse(source)?;
    allowed(&url, origins, cx).await?;
    let frame = cx
        .update(|cx| {
            cx.global::<BrowserState>()
                .tab(page)
                .and_then(|t| t.pick.frames.borrow().get(&Vec::new()).cloned())
        })
        .ok_or_else(|| anyhow::anyhow!("frame gone"))?;
    let result = reader::protocol(page,"Network.loadNetworkResource",json!({"frameId":frame,"url":source,"options":{"disableCache":false,"includeCredentials":true}}),cx).await?;
    let resource = &result["resource"];
    anyhow::ensure!(resource["success"] == true, "resource unavailable");
    let stream = resource["stream"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("empty resource"))?;
    let result = read(page, stream, cx).await;
    let _ = reader::protocol(page, "IO.close", json!({"handle":stream}), cx).await;
    let bytes = result?;
    let mime = resource["headers"]
        .as_object()
        .and_then(|h| {
            h.iter()
                .find(|(k, _)| k.eq_ignore_ascii_case("content-type"))
        })
        .and_then(|(_, v)| v.as_str())
        .unwrap_or_default()
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    let mime = sniff(&bytes, &mime);
    Ok(Asset { mime, bytes })
}
async fn read(page: &TabId, stream: &str, cx: &AsyncApp) -> anyhow::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    loop {
        let value = reader::protocol(page, "IO.read", json!({"handle":stream}), cx).await?;
        let data = value["data"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("missing resource data"))?;
        if value["base64Encoded"] == true {
            bytes.extend(STANDARD.decode(data)?);
        } else {
            bytes.extend(data.as_bytes());
        }
        anyhow::ensure!(bytes.len() <= 3 * 1024 * 1024, "resource too large");
        if value["eof"] == true {
            return Ok(bytes);
        }
    }
}
fn sniff(bytes: &[u8], mime: &str) -> String {
    for (magic, mime) in [
        (b"wOF2".as_slice(), "font/woff2"),
        (b"wOFF", "font/woff"),
        (b"OTTO", "font/otf"),
        (b"\0\x01\0\0", "font/ttf"),
        (b"true", "font/ttf"),
    ] {
        if bytes.starts_with(magic) {
            return mime.into();
        }
    }
    if let Ok(format) = image::guess_format(bytes) {
        return format.to_mime_type().into();
    }
    if matches!(
        mime,
        "image/svg+xml" | "image/x-icon" | "image/vnd.microsoft.icon" | "image/bmp"
    ) {
        return mime.into();
    }
    if String::from_utf8_lossy(&bytes[..bytes.len().min(512)]).contains("<svg") {
        return "image/svg+xml".into();
    }
    mime.to_owned()
}
