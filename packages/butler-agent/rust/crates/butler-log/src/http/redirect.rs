//! Redirect policy evaluated at the logging boundary, once per network hop.
use super::Error;
use reqwest::{Method, Request, Response, Url};
use std::sync::Arc;

type Decide = dyn Fn(Attempt<'_>) -> Action + Send + Sync;
#[derive(Clone)]
pub struct Policy(Arc<Decide>);
impl std::fmt::Debug for Policy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("RedirectPolicy")
    }
}
pub struct Attempt<'a> {
    status: reqwest::StatusCode,
    next: &'a Url,
    previous: &'a [Url],
}
pub enum Action {
    Follow,
    Stop,
    Error(String),
}
impl Policy {
    pub fn limited(max: usize) -> Self {
        Self::custom(move |attempt| {
            if attempt.previous.len() > max {
                attempt.error("too many redirects")
            } else {
                attempt.follow()
            }
        })
    }
    pub fn none() -> Self {
        Self::custom(|_| Action::Stop)
    }
    pub fn custom(policy: impl Fn(Attempt<'_>) -> Action + Send + Sync + 'static) -> Self {
        Self(Arc::new(policy))
    }
    pub(super) fn next(
        &self,
        response: &Response,
        request: Option<Request>,
        previous: &[Url],
    ) -> Result<Option<Request>, Error> {
        let status = response.status();
        if !matches!(status.as_u16(), 301 | 302 | 303 | 307 | 308) {
            return Ok(None);
        }
        let Some(mut request) = request else {
            return Ok(None);
        };
        let next = response
            .headers()
            .get("location")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| response.url().join(v).ok());
        let Some(next) = next else { return Ok(None) };
        if !matches!(next.scheme(), "http" | "https") {
            return Err(Error::Redirect("unsupported redirect scheme".into()));
        }
        match (self.0)(Attempt {
            status,
            next: &next,
            previous,
        }) {
            Action::Stop => return Ok(None),
            Action::Error(message) => return Err(Error::Redirect(message)),
            Action::Follow => {}
        }
        if matches!(status.as_u16(), 301..=303)
            && !matches!(*request.method(), Method::GET | Method::HEAD)
        {
            *request.method_mut() = Method::GET;
            *request.body_mut() = None;
            for name in [
                "content-length",
                "content-type",
                "transfer-encoding",
                "content-encoding",
            ] {
                request.headers_mut().remove(name);
            }
        }
        if request.url().host_str() != next.host_str()
            || request.url().port_or_known_default() != next.port_or_known_default()
        {
            for name in [
                "authorization",
                "cookie",
                "proxy-authorization",
                "www-authenticate",
                "x-api-key",
                "x-goog-api-key",
            ] {
                request.headers_mut().remove(name);
            }
        }
        request.headers_mut().remove("referer");
        if !(request.url().scheme() == "https" && next.scheme() == "http") {
            let mut referer = request.url().clone();
            let _ = referer.set_username("");
            let _ = referer.set_password(None);
            referer.set_fragment(None);
            if let Ok(value) = referer.as_str().parse() {
                request.headers_mut().insert("referer", value);
            }
        }
        *request.url_mut() = next;
        Ok(Some(request))
    }
}
impl<'a> Attempt<'a> {
    pub fn url(&self) -> &'a Url {
        self.next
    }
    pub fn previous(&self) -> &'a [Url] {
        self.previous
    }
    pub fn status(&self) -> reqwest::StatusCode {
        self.status
    }
    pub fn follow(self) -> Action {
        Action::Follow
    }
    pub fn stop(self) -> Action {
        Action::Stop
    }
    pub fn error(self, message: impl std::fmt::Display) -> Action {
        Action::Error(message.to_string())
    }
}
