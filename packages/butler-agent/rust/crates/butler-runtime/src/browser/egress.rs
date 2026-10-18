//! Egress of Butler-driven browsing: one guard for every destination.
//!
//! The rules match the App's navigation guard: `http`/`https` only, no
//! credentials in the URL, no `localhost` names, and a host is reachable only
//! when every address it resolves to is public. The one loopback exception is
//! Butler's own output origin, and only its `/__o/` capability paths.
//!
//! [`EgressProxy`] enforces them on the network path itself: the browser
//! resolves nothing (its resolver maps every name to "not found"), the proxy
//! resolves each destination, checks every address, and connects to exactly
//! the address it checked, so a rebinding DNS answer cannot reach a private
//! address between check and connect. Plain-HTTP requests are rewritten to
//! one request per connection, so a reused proxy connection can never carry
//! a request to another host.
use super::public_url;
use butler_log::http::{Connection, Purpose};
use std::{
    io,
    net::{IpAddr, SocketAddr},
    time::Duration,
};
use tokio::{
    io::AsyncWriteExt,
    net::{TcpListener, TcpStream},
};
use tokio_util::sync::CancellationToken;
use tracing::Instrument;
mod wire;
use wire::{Head, read_head, relay, rewrite};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// A tunnel lives at most as long as an agent tab may stay idle.
const MAX_TUNNEL: Duration = Duration::from_secs(600);

/// Butler's output origin: `127.0.0.1` on the content port.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ContentOrigin(pub u16);

impl ContentOrigin {
    pub fn origin(self) -> String {
        format!("http://127.0.0.1:{}", self.0)
    }
    /// Butler's output origin itself, any path (a registered preview's root mount).
    fn hosts(self, host: &str, port: u16) -> bool {
        host == "127.0.0.1" && port == self.0
    }
    fn admits(self, host: &str, port: u16, path: &str) -> bool {
        host == "127.0.0.1" && port == self.0 && path.starts_with("/__o/")
    }
}

/// Whether an address is loopback, private, link-local, shared, multicast or
/// otherwise not a public destination.
pub fn private_address(ip: IpAddr) -> bool {
    super::private_ip(ip)
}

/// Resolves `host` and returns its addresses only when every one is public.
pub async fn public_addresses(host: &str, port: u16) -> Result<Vec<SocketAddr>, &'static str> {
    let host = host.trim_start_matches('[').trim_end_matches(']');
    let lowered = host.to_ascii_lowercase();
    let name = lowered.trim_end_matches('.');
    if name == "localhost" || name.ends_with(".localhost") || name.is_empty() {
        return Err("navigation_denied");
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        return if private_address(ip) {
            Err("navigation_denied")
        } else {
            Ok(vec![SocketAddr::new(ip, port)])
        };
    }
    let addresses: Vec<SocketAddr> = tokio::net::lookup_host((host, port))
        .await
        .map_err(|_| "navigation_denied")?
        .collect();
    if addresses.is_empty() || addresses.iter().any(|a| private_address(a.ip())) {
        return Err("navigation_denied");
    }
    Ok(addresses)
}

/// The App's `guardUrl`: may a Butler-driven frame load `raw`?
pub async fn guard_url(raw: &str, content: Option<ContentOrigin>) -> bool {
    let Ok(url) = url::Url::parse(raw) else {
        return false;
    };
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return false;
    }
    let (Some(host), Some(port)) = (url.host_str(), url.port_or_known_default()) else {
        return false;
    };
    if content.is_some_and(|c| url.scheme() == "http" && c.admits(host, port, url.path())) {
        return true;
    }
    public_url(raw).is_ok() && public_addresses(host, port).await.is_ok()
}

/// [`guard_url`] for a registered preview's tab: also the output origin's
/// root mount, where the preview's dev server is proxied.
pub async fn guard_preview_url(raw: &str, content: Option<ContentOrigin>) -> bool {
    let preview = url::Url::parse(raw).is_ok_and(|url| {
        url.scheme() == "http"
            && url.username().is_empty()
            && url.password().is_none()
            && content
                .is_some_and(|c| c.hosts(url.host_str().unwrap_or(""), url.port().unwrap_or(0)))
    });
    preview || guard_url(raw, content).await
}

/// The guard's one test exception: loopback addresses a test fixture serves,
/// named exactly (IP literal and port). Production passes none, and nothing
/// else on loopback, the LAN or link-local becomes reachable through it.
#[derive(Clone, Debug, Default)]
pub struct LoopbackFixtures(Vec<SocketAddr>);

impl LoopbackFixtures {
    /// Production: no exception.
    pub fn none() -> Self {
        Self::default()
    }

    /// The loopback `host:port` of each fixture URL (others are ignored).
    #[cfg(any(test, feature = "test-support"))]
    pub fn serving(urls: &[&str]) -> Self {
        Self(
            urls.iter()
                .filter_map(|raw| url::Url::parse(raw).ok())
                .filter_map(|url| {
                    let ip = url.host_str()?.parse::<IpAddr>().ok()?;
                    let port = url.port_or_known_default()?;
                    ip.is_loopback().then(|| SocketAddr::new(ip, port))
                })
                .collect(),
        )
    }

    fn admits(&self, url: &url::Url) -> bool {
        let Some(ip) = url
            .host_str()
            .and_then(|h| h.trim_matches(['[', ']']).parse::<IpAddr>().ok())
        else {
            return false;
        };
        url.port_or_known_default()
            .is_some_and(|port| self.0.contains(&SocketAddr::new(ip, port)))
    }
}

/// Whether a server-side fetch (`web_read`) may request `url`: the
/// navigation guard's syntax (`http`/`https`, no credentials, no localhost
/// names, no private address literal); names are checked when they resolve.
pub fn fetch_permitted(url: &url::Url, fixtures: &LoopbackFixtures) -> bool {
    fixtures.admits(url) || public_url(url.as_str()).is_ok()
}

/// Resolves only names whose every address is public, so the client
/// connects to exactly the addresses this check saw (no DNS rebinding).
struct PublicResolver;

impl reqwest::dns::Resolve for PublicResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let host = name.as_str().to_owned();
        Box::pin(async move {
            let addresses = public_addresses(&host, 0).await?;
            Ok(Box::new(addresses.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

/// A fetch client behind the egress guard: public resolution, and every
/// redirect hop re-checked. Hops carrying credentials stop, as before.
pub fn guarded_client(
    builder: butler_log::http::ClientBuilder,
    fixtures: LoopbackFixtures,
) -> butler_log::http::ClientBuilder {
    builder
        .dns_resolver(std::sync::Arc::new(PublicResolver))
        .redirect(butler_log::http::RedirectPolicy::custom(move |attempt| {
            if attempt.previous().len() >= 10 {
                return attempt.error("too many redirects");
            }
            if !attempt.url().username().is_empty() || attempt.url().password().is_some() {
                return attempt.stop();
            }
            if !fetch_permitted(attempt.url(), &fixtures) {
                return attempt.error("navigation_denied");
            }
            attempt.follow()
        }))
}

#[derive(Clone, Copy)]
struct Scope {
    content: Option<ContentOrigin>,
    preview: bool,
}

impl Scope {
    /// The output origin as this proxy may reach it, for `host:port` + `path`.
    fn content(self, host: &str, port: u16, path: Option<&str>) -> bool {
        self.content.is_some_and(|c| {
            (self.preview && c.hosts(host, port))
                || path.is_some_and(|path| c.admits(host, port, path))
        })
    }
}

/// A loopback HTTP proxy that admits public destinations only.
pub struct EgressProxy {
    address: SocketAddr,
    stop: CancellationToken,
}

impl EgressProxy {
    /// A proxy for conversation tabs: public destinations and output capabilities.
    pub async fn start(content: Option<ContentOrigin>) -> io::Result<Self> {
        Self::listen(Scope {
            content,
            preview: false,
        })
        .await
    }

    /// A proxy for a registered dev-server preview's tabs: also the output
    /// origin's root mount and its WebSocket (HMR), nothing else on loopback.
    pub async fn start_preview(content: ContentOrigin) -> io::Result<Self> {
        Self::listen(Scope {
            content: Some(content),
            preview: true,
        })
        .await
    }

    async fn listen(scope: Scope) -> io::Result<Self> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let address = listener.local_addr()?;
        let stop = CancellationToken::new();
        let token = stop.clone();
        tokio::spawn(
            async move {
                loop {
                    let accepted = tokio::select! {
                        () = token.cancelled() => break,
                        accepted = listener.accept() => accepted,
                    };
                    let Ok((client, peer)) = accepted else {
                        continue;
                    };
                    if !peer.ip().is_loopback() {
                        continue;
                    }
                    let token = token.clone();
                    tokio::spawn(
                        async move {
                            tokio::select! {
                                () = token.cancelled() => {},
                                _ = tokio::time::timeout(MAX_TUNNEL, serve(client, scope)) => {},
                            }
                        }
                        .in_current_span(),
                    );
                }
            }
            .in_current_span(),
        );
        Ok(Self { address, stop })
    }

    /// `http://127.0.0.1:<port>` for the browser's `--proxy-server`.
    pub fn url(&self) -> String {
        format!("http://{}", self.address)
    }
}

impl Drop for EgressProxy {
    fn drop(&mut self) {
        self.stop.cancel();
    }
}

async fn refuse(client: &mut TcpStream) {
    let _ = client
        .write_all(b"HTTP/1.1 403 Forbidden\r\nX-Butler-Egress: navigation_denied\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
        .await;
    let _ = client.shutdown().await;
}

async fn serve(mut client: TcpStream, scope: Scope) {
    let Some(head) = read_head(&mut client).await else {
        return;
    };
    if head.method.eq_ignore_ascii_case("CONNECT") {
        tunnel(client, head, scope).await;
    } else {
        forward(client, head, scope).await;
    }
}

async fn tunnel(mut client: TcpStream, head: Head, scope: Scope) {
    let Some((host, port)) = head
        .target
        .rsplit_once(':')
        .and_then(|(host, port)| Some((host.to_owned(), port.parse::<u16>().ok()?)))
    else {
        return refuse(&mut client).await;
    };
    let log = Connection::new(&host, port, &Purpose::new("browser.egress"));
    let result = async {
        let addresses = destination(&host, port, None, scope).await?;
        let mut upstream = match log.connect(&addresses, CONNECT_TIMEOUT).await {
            Ok(stream) => stream,
            Err(error) => {
                let _ = client.write_all(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
                return Err(error);
            }
        };
        client.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n").await?;
        upstream.write_all(&head.rest).await?;
        tokio::io::copy_bidirectional(&mut client, &mut upstream).await?;
        Ok(())
    }.await;
    if result
        .as_ref()
        .is_err_and(|error| error.kind() == io::ErrorKind::PermissionDenied)
    {
        refuse(&mut client).await;
    }
    log.finish(result);
}

async fn destination(
    host: &str,
    port: u16,
    path: Option<&str>,
    scope: Scope,
) -> io::Result<Vec<SocketAddr>> {
    if scope.content(host, port, path) {
        Ok(vec![SocketAddr::from(([127, 0, 0, 1], port))])
    } else {
        public_addresses(host, port)
            .await
            .map_err(|_| io::ErrorKind::PermissionDenied.into())
    }
}

async fn forward(mut client: TcpStream, head: Head, scope: Scope) {
    let Ok(url) = url::Url::parse(&head.target) else {
        return refuse(&mut client).await;
    };
    let (Some(host), Some(port)) = (url.host_str(), url.port_or_known_default()) else {
        return refuse(&mut client).await;
    };
    let log = Connection::new(host, port, &Purpose::new("browser.egress"));
    if url.scheme() != "http" || !url.username().is_empty() || url.password().is_some() {
        refuse(&mut client).await;
        return log.finish(Err(io::ErrorKind::PermissionDenied.into()));
    }
    let upstream = match async {
        let addresses = destination(host, port, Some(url.path()), scope).await?;
        log.connect(&addresses, CONNECT_TIMEOUT).await
    }
    .await
    {
        Ok(stream) => stream,
        Err(error) => {
            refuse(&mut client).await;
            return log.finish(Err(error));
        }
    };
    let mut path = url.path().to_owned();
    if let Some(query) = url.query() {
        path.push('?');
        path.push_str(query);
    }
    let request = rewrite(
        &format!("{} {path} {}", head.method, head.version),
        &head.headers,
    );
    log.finish(relay(client, upstream, request, head.rest).await);
}
