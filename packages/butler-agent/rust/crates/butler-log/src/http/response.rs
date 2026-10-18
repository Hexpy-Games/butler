//! Preserve reqwest's response URL when replacing its body with an observer.
use reqwest::ResponseBuilderExt;

pub(super) fn split(response: reqwest::Response) -> (::http::response::Parts, reqwest::Body) {
    // reqwest stores the URL outside http::Response and its Into conversion
    // does not retain it. The public extension restores it on reconstruction.
    let mut builder = ::http::Response::builder().url(response.url().clone());
    let raw: ::http::Response<reqwest::Body> = response.into();
    let (mut parts, body) = raw.into_parts();
    if let Some(extensions) = builder.extensions_mut() {
        parts.extensions.extend(std::mem::take(extensions));
    }
    (parts, body)
}
