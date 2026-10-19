use super::{Phase, Purpose};
#[derive(Debug)]
pub struct RequestBuilder {
    pub(super) inner: reqwest::RequestBuilder,
    pub(super) purpose: Purpose,
    pub(super) phase: Phase,
    pub(super) redirect: super::redirect::Policy,
    pub(super) timeout: Option<std::time::Duration>,
}
impl RequestBuilder {
    pub fn purpose(mut self, purpose: Purpose) -> Self {
        self.purpose = purpose;
        self
    }
    pub fn phase(mut self, phase: Phase) -> Self {
        self.phase = phase;
        self
    }
    pub fn try_clone(&self) -> Option<Self> {
        Some(Self {
            inner: self.inner.try_clone()?,
            purpose: self.purpose.clone(),
            phase: self.phase.clone(),
            redirect: self.redirect.clone(),
            timeout: self.timeout,
        })
    }
    pub fn send(
        self,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<reqwest::Response, super::Error>> + Send>,
    > {
        Box::pin(async move {
            let purpose = self.purpose.clone();
            let phase = self.phase.clone();
            super::send(self, purpose, phase).await
        })
    }
    pub fn header<K, V>(mut self, key: K, value: V) -> Self
    where
        reqwest::header::HeaderName: TryFrom<K>,
        <reqwest::header::HeaderName as TryFrom<K>>::Error: Into<::http::Error>,
        reqwest::header::HeaderValue: TryFrom<V>,
        <reqwest::header::HeaderValue as TryFrom<V>>::Error: Into<::http::Error>,
    {
        self.inner = self.inner.header(key, value);
        self
    }
    pub fn headers(mut self, value: reqwest::header::HeaderMap) -> Self {
        self.inner = self.inner.headers(value);
        self
    }
    pub fn bearer_auth<T: std::fmt::Display>(mut self, token: T) -> Self {
        self.inner = self.inner.bearer_auth(token);
        self
    }
    pub fn body<T: Into<reqwest::Body>>(mut self, body: T) -> Self {
        self.inner = self.inner.body(body);
        self
    }
    pub fn timeout(mut self, value: std::time::Duration) -> Self {
        self.inner = self.inner.timeout(value);
        self
    }
    pub fn json<T: serde::Serialize + ?Sized>(mut self, value: &T) -> Self {
        self.inner = self.inner.json(value);
        self
    }
    pub fn form<T: serde::Serialize + ?Sized>(mut self, value: &T) -> Self {
        self.inner = self.inner.form(value);
        self
    }
    pub fn query<T: serde::Serialize + ?Sized>(mut self, value: &T) -> Self {
        self.inner = self.inner.query(value);
        self
    }
}
