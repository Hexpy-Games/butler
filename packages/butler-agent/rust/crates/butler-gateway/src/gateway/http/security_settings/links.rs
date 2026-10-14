//! Connection addresses shared by Settings → Security and the remote CLI.
use super::super::listeners::RemoteSnapshot;
use axum::http::uri::Authority;
use std::net::IpAddr;

pub(super) fn connection_urls(remote: &RemoteSnapshot, port: u16) -> Vec<String> {
    let mut urls: Vec<_> = remote
        .lan_authorities
        .iter()
        .map(|authority| format!("http://{authority}"))
        .collect();
    for host in &remote.exposure.allowed_hosts {
        let Ok(authority) = host.parse::<Authority>() else {
            continue;
        };
        let name = authority.host().trim_end_matches('.');
        let local = name.trim_matches(['[', ']']).parse::<IpAddr>().is_ok()
            || !name.contains('.')
            || [".localhost", ".local", ".lan", ".home.arpa"]
                .iter()
                .any(|suffix| name.ends_with(suffix));
        if local && !remote.exposure.remote_access_enabled {
            continue;
        }
        let url = if local {
            format!(
                "http://{}:{}",
                authority.host(),
                authority.port_u16().unwrap_or(port)
            )
        } else {
            format!("https://{}", authority.host())
        };
        if !urls.contains(&url) {
            urls.push(url);
        }
    }
    urls
}
