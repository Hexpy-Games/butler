use super::{Phase, Purpose, RequestBuilder};
#[derive(Clone, Debug)]
pub struct Client {
    inner: reqwest::Client,
    purpose: Purpose,
    redirect: super::redirect::Policy,
    timeout: Option<std::time::Duration>,
}
pub struct ClientBuilder {
    inner: reqwest::ClientBuilder,
    purpose: Purpose,
    redirect: super::redirect::Policy,
    timeout: Option<std::time::Duration>,
}
impl ClientBuilder {
    pub(super) fn new(purpose: Purpose) -> Self {
        Self {
            inner: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .retry(reqwest::retry::never()),
            redirect: super::redirect::Policy::limited(10),
            timeout: None,
            purpose,
        }
    }
    pub fn build(self) -> Result<Client, reqwest::Error> {
        Ok(Client {
            inner: self.inner.build()?,
            redirect: self.redirect,
            timeout: self.timeout,
            purpose: self.purpose,
        })
    }
    pub fn timeout(mut self, value: std::time::Duration) -> Self {
        self.timeout = Some(value);
        self.inner = self.inner.timeout(value);
        self
    }
    pub fn read_timeout(mut self, value: std::time::Duration) -> Self {
        self.inner = self.inner.read_timeout(value);
        self
    }
    pub fn connect_timeout(mut self, value: std::time::Duration) -> Self {
        self.inner = self.inner.connect_timeout(value);
        self
    }
    pub fn redirect(mut self, value: super::redirect::Policy) -> Self {
        self.redirect = value;
        self
    }
    pub fn local_address(mut self, value: std::net::IpAddr) -> Self {
        self.inner = self.inner.local_address(value);
        self
    }
    pub fn pool_max_idle_per_host(mut self, value: usize) -> Self {
        self.inner = self.inner.pool_max_idle_per_host(value);
        self
    }
    pub fn proxy(mut self, value: reqwest::Proxy) -> Self {
        self.inner = self.inner.proxy(value);
        self
    }
    pub fn dns_resolver<R: reqwest::dns::Resolve + 'static>(
        mut self,
        value: std::sync::Arc<R>,
    ) -> Self {
        self.inner = self.inner.dns_resolver(value);
        self
    }
    pub fn no_gzip(mut self) -> Self {
        self.inner = self.inner.no_gzip();
        self
    }
    pub fn no_brotli(mut self) -> Self {
        self.inner = self.inner.no_brotli();
        self
    }
    pub fn no_deflate(mut self) -> Self {
        self.inner = self.inner.no_deflate();
        self
    }
    pub fn no_proxy(mut self) -> Self {
        self.inner = self.inner.no_proxy();
        self
    }
    pub fn https_only(mut self, value: bool) -> Self {
        self.inner = self.inner.https_only(value);
        self
    }
    pub fn user_agent<V>(mut self, value: V) -> Self
    where
        V: TryInto<reqwest::header::HeaderValue>,
        V::Error: Into<::http::Error>,
    {
        self.inner = self.inner.user_agent(value);
        self
    }
    pub fn resolve_to_addrs(mut self, domain: &str, addrs: &[std::net::SocketAddr]) -> Self {
        self.inner = self.inner.resolve_to_addrs(domain, addrs);
        self
    }
}
impl Client {
    pub fn request<U: reqwest::IntoUrl>(&self, method: reqwest::Method, url: U) -> RequestBuilder {
        RequestBuilder {
            inner: self.inner.request(method, url),
            purpose: self.purpose.clone(),
            phase: Phase::default(),
            redirect: self.redirect.clone(),
            timeout: self.timeout,
        }
    }
    pub fn get<U: reqwest::IntoUrl>(&self, url: U) -> RequestBuilder {
        self.request(reqwest::Method::GET, url)
    }
    pub fn post<U: reqwest::IntoUrl>(&self, url: U) -> RequestBuilder {
        self.request(reqwest::Method::POST, url)
    }
    pub fn put<U: reqwest::IntoUrl>(&self, url: U) -> RequestBuilder {
        self.request(reqwest::Method::PUT, url)
    }
    pub fn patch<U: reqwest::IntoUrl>(&self, url: U) -> RequestBuilder {
        self.request(reqwest::Method::PATCH, url)
    }
    pub fn delete<U: reqwest::IntoUrl>(&self, url: U) -> RequestBuilder {
        self.request(reqwest::Method::DELETE, url)
    }
    pub fn head<U: reqwest::IntoUrl>(&self, url: U) -> RequestBuilder {
        self.request(reqwest::Method::HEAD, url)
    }
}
